import {WebSocketServer, WebSocket} from 'ws';
import type {Duplex} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {STATUS_CODES} from 'node:http';
import {randomBytes, randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import {isIPv6} from "node:net";
import {resolveCodec, type Codec, type CodecOption} from "../codec.js";

export {jsonCodec, devalueCodec, type Codec, type CodecOption} from "../codec.js";
import {KEY_PROTOCOL_PREFIX} from "../keys.js";
export {KEY_PROTOCOL, KEY_PROTOCOL_PREFIX, splitConnectionKey} from "../keys.js";

/**
 * The connection key of an upgrade request: from the `Sec-WebSocket-Protocol` header (where the client
 * puts it, see {@link splitConnectionKey}), or from `?key=` when `allowQuery`.
 */
export function connectionKey(req: IncomingMessage, allowQuery = true): string | undefined {
    const header = req.headers['sec-websocket-protocol'];
    if (header) {
        for (const protocol of header.split(',')) {
            const value = protocol.trim();
            if (value.startsWith(KEY_PROTOCOL_PREFIX)) return value.slice(KEY_PROTOCOL_PREFIX.length) || undefined;
        }
    }
    if (!allowQuery) return undefined;
    return parseUrl(req).searchParams.get('key') || undefined;
}

// Enhanced BufferLike type with better type safety
export type BufferLike =
    | string
    | Buffer
    | DataView
    | number
    | ArrayBufferView
    | Uint8Array
    | ArrayBuffer
    | SharedArrayBuffer
    | Blob
    | readonly any[]
    | readonly number[]
    | { valueOf(): ArrayBuffer }
    | { valueOf(): SharedArrayBuffer }
    | { valueOf(): Uint8Array }
    | { valueOf(): readonly number[] }
    | { valueOf(): string }
    | { [Symbol.toPrimitive](hint: string): string };

export type WebSocketSendOptions = {
    mask?: boolean | undefined;
    binary?: boolean | undefined;
    compress?: boolean | undefined;
    fin?: boolean | undefined;
};

type MaybePromise<T> = T | Promise<T>;
type RequestEventLike = { url: URL };

declare global {
    var websockets: typeof WebSockets;
}

export type ClientAddressOptions = {
    /**
     * Header holding the client address, set by your reverse proxy, e.g. `'x-forwarded-for'` or
     * `'x-real-ip'`. Default: the `ADDRESS_HEADER` environment variable (as used by adapter-node), else none.
     */
    addressHeader?: string;
    /**
     * With `x-forwarded-for`, the number of trusted proxies in front of the server: the address is taken
     * this many entries from the right. Default: the `XFF_DEPTH` environment variable, else `1`.
     */
    xffDepth?: number;
};

/**
 * The client's IP address, resolved the same way adapter-node's `getClientAddress()` does. Without an
 * address header this is the TCP peer, which behind a reverse proxy is the proxy itself.
 *
 * The header is trusted only when configured: any client can send `X-Forwarded-For`, so only the entries
 * your own proxies appended (the rightmost `xffDepth`) are used. When the header is missing or shorter than
 * `xffDepth`, the TCP peer address is used.
 */
export function clientAddress(req: IncomingMessage, options: ClientAddressOptions = {}): string {
    const peer = normalizeAddress(req.socket?.remoteAddress) ?? 'unknown';
    const header = (options.addressHeader ?? process.env.ADDRESS_HEADER ?? '').trim().toLowerCase();
    if (!header) return peer;

    const raw = req.headers[header];
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    if (!value) return peer;

    if (header === 'x-forwarded-for') {
        const depth = options.xffDepth ?? (Number.parseInt(process.env.XFF_DEPTH ?? '', 10) || 1);
        const addresses = value.split(',').map((address) => address.trim()).filter(Boolean);
        if (depth < 1 || depth > addresses.length) return peer;
        return normalizeAddress(addresses[addresses.length - depth]) ?? peer;
    }
    return normalizeAddress(value) ?? peer;
}

/** Strips IPv4-mapped IPv6 prefixes (`::ffff:1.2.3.4`), zone ids and brackets. */
function normalizeAddress(address: string | undefined): string | undefined {
    if (!address) return undefined;
    let result = address.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(result)) result = result.slice(7);
    return result || undefined;
}

/**
 * The rate-limit bucket for an address. An IPv6 client usually controls a whole /64, so it would otherwise
 * get a fresh limit for every address it picks from it.
 */
function rateLimitKey(address: string): string {
    if (!isIPv6(address)) return address;
    const [head, tail = ''] = address.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = address.includes('::') && tail ? tail.split(':') : [];
    const groups = address.includes('::')
        ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
        : left;
    return groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Default `WebSocketEndpointConfig.maxPayload`: 1 MiB. */
export const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
/** Default `WebSocketEndpointConfig.heartbeat` interval: 30 seconds. */
export const DEFAULT_HEARTBEAT = 30_000;

// Enhanced socket with better metadata tracking
/**
 * @typeParam In - messages this socket receives (decoded by {@link ReferencedWebSocket.onMessage})
 * @typeParam Out - messages this socket sends with {@link ReferencedWebSocket.sendMessage}
 */
export class ReferencedWebSocket<In = unknown, Out = unknown> extends WebSocket {
    private _ref: string = randomUUID();
    private _connectedAt: number = Date.now();

    /** Encodes {@link sendMessage} and decodes {@link onMessage}. Set from the endpoint's `codec` config. */
    codec: Codec = resolveCodec(undefined);

    params?: Record<string, string>;
    timeoutTimer?: NodeJS.Timeout;
    lastActivity?: number;
    public metadata: Record<string, any> = {};

    declare binaryType: WebSocket['binaryType'];
    declare readonly bufferedAmount: WebSocket['bufferedAmount'];
    declare readonly extensions: WebSocket['extensions'];
    declare readonly isPaused: WebSocket['isPaused'];
    declare readonly protocol: WebSocket['protocol'];
    declare readonly readyState: WebSocket['readyState'];
    declare readonly url: WebSocket['url'];
    declare readonly CONNECTING: WebSocket['CONNECTING'];
    declare readonly OPEN: WebSocket['OPEN'];
    declare readonly CLOSING: WebSocket['CLOSING'];
    declare readonly CLOSED: WebSocket['CLOSED'];
    declare onopen: WebSocket['onopen'];
    declare onerror: WebSocket['onerror'];
    declare onclose: WebSocket['onclose'];
    declare onmessage: WebSocket['onmessage'];

    /**
     * Returns the socket reference id
     */
    get ref() {
        return this._ref;
    }

    /**
     * Returns the time (millis) the sockets connected (upgraded)
     */
    get connectedAt() {
        return this._connectedAt;
    }

    /**
     * Return the time (millis) the socket is connected
     */
    get uptime() {
        return Date.now() - this._connectedAt;
    }

    send(data: BufferLike, cb?: (err?: Error) => void): void;
    send(data: BufferLike, options: WebSocketSendOptions, cb?: (err?: Error) => void): void;
    send(data: BufferLike, optionsOrCallback?: WebSocketSendOptions | ((err?: Error) => void), cb?: (err?: Error) => void): void {
        if (typeof optionsOrCallback === 'function') {
            super.send(data, optionsOrCallback);
            return;
        }

        if (optionsOrCallback) {
            super.send(data, optionsOrCallback, cb);
            return;
        }

        super.send(data, cb);
    }

    close(code?: number, data?: string | Buffer): void {
        super.close(code, data);
    }

    ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void {
        super.ping(data, mask, cb);
    }

    pong(data?: any, mask?: boolean, cb?: (err: Error) => void): void {
        super.pong(data, mask, cb);
    }

    terminate(): void {
        super.terminate();
    }

    /** Encodes `message` with the endpoint's codec (JSON by default) and sends it as a text frame. */
    sendMessage(message: Out, cb?: (err?: Error) => void): void {
        let data: string;
        try {
            data = this.codec.encode(message);
        } catch (error) {
            if (!cb) throw error;
            cb(error as Error);
            return;
        }
        super.send(data, cb);
    }

    /**
     * Calls `listener` with every message from the client, decoded with the endpoint's codec (JSON by
     * default). A message that can't be decoded (or a binary frame) is skipped and passed to `onError`, or
     * emitted as the socket's `'error'` event (reported by the endpoint) when `onError` is omitted.
     * Decoded messages come from the client: validate them before trusting their shape.
     * @returns a function that removes the listener
     */
    onMessage(listener: (message: In) => unknown, onError?: (error: Error) => unknown): () => void {
        const handler = (data: WebSocket.RawData, isBinary: boolean) => {
            let message: In;
            try {
                if (isBinary) throw new TypeError('Received a binary frame on a typed socket');
                message = this.codec.decode(data.toString()) as In;
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (onError) onError(err);
                else if (this.listenerCount('error') > 0) this.emit('error', err);
                else console.error('[sveltekit-websockets] could not decode message:', err);
                return;
            }
            listener(message);
        };
        this.on('message', handler);
        return () => {
            this.off('message', handler);
        };
    }

    pause(): void {
        super.pause();
    }

    resume(): void {
        super.resume();
    }

    addEventListener<K extends keyof WebSocket.WebSocketEventMap>(
        type: K,
        listener:
            | ((event: WebSocket.WebSocketEventMap[K]) => void)
            | { handleEvent(event: WebSocket.WebSocketEventMap[K]): void },
        options?: WebSocket.EventListenerOptions,
    ): void {
        super.addEventListener(type, listener, options);
    }

    removeEventListener<K extends keyof WebSocket.WebSocketEventMap>(
        type: K,
        listener:
            | ((event: WebSocket.WebSocketEventMap[K]) => void)
            | { handleEvent(event: WebSocket.WebSocketEventMap[K]): void },
    ): void {
        super.removeEventListener(type, listener);
    }

    on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    once(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.once(event, listener);
    }

    off(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.off(event, listener);
    }

    addListener(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.addListener(event, listener);
    }

    removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.removeListener(event, listener);
    }

    emit(event: string | symbol, ...args: any[]): boolean {
        return super.emit(event, ...args);
    }

    removeAllListeners(event?: string | symbol): this {
        return super.removeAllListeners(event);
    }

    listeners(event: string | symbol): Array<(...args: any[]) => void> {
        return super.listeners(event);
    }

    rawListeners(event: string | symbol): Array<(...args: any[]) => void> {
        return super.rawListeners(event);
    }

    listenerCount(event: string | symbol, listener?: (...args: any[]) => void): number {
        return super.listenerCount(event, listener);
    }

    prependListener(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.prependListener(event, listener);
    }

    prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.prependOnceListener(event, listener);
    }

    eventNames(): Array<string | symbol> {
        return super.eventNames();
    }

    setMaxListeners(n: number): this {
        return super.setMaxListeners(n);
    }

    getMaxListeners(): number {
        return super.getMaxListeners();
    }
}

// Enhanced pending key tracking
interface PendingKey {
    key: string;
    createdAt: number;
    expiresAt: number;
}

/**
 * Close codes used when the server closes a connection. Several names share a code (e.g. `1008` is the
 * generic "policy violation" code), so this is a plain object rather than an enum: an enum's reverse
 * lookup (`WebSocketError[1008]`) could only ever return one of the names.
 */
export const WebSocketError = {
    TOO_MANY_CONNECTIONS: 1013,
    INVALID_KEY: 1008,
    MISSING_PARAM: 1008,
    AUTH_FAILED: 1008,
    ORIGIN_NOT_ALLOWED: 1008,
    TIMEOUT: 1001,
    RATE_LIMITED: 1013
} as const;

export type WebSocketError = typeof WebSocketError[keyof typeof WebSocketError];

/**
 * Why an upgrade was refused. Before the handshake it is sent as an HTTP response (`status`, `reason` as
 * body, `headers`); on a socket that is already open it becomes a close frame (`code`, `reason`).
 */
export type UpgradeRejection = {
    status: number;
    code: number;
    reason: string;
    headers?: Record<string, string>;
};

export type UpgradeHandler = (input: {
    req: IncomingMessage,
    head: Buffer,
    accept: () => MaybePromise<unknown>,
    /**
     * Rejects the upgrade with a plain HTTP response.
     * @param reason sent as the response body
     * @param code HTTP status code, `400`–`599` (default `400`); anything else is sent as `400`
     */
    decline: (reason: string, code?: number) => unknown
}) => MaybePromise<any>;

export type UpgradeHandle = (req: IncomingMessage, socket: Duplex, head: Buffer) => MaybePromise<any>;

export type GenericWebSocketEndpointConfig = {
    disposer?: () => void;
}

export interface GenericWebSocketEndpointController {
    destroy(): void;

    gracefulShutdown?(timeout?: number): Promise<void>;

    get config(): WebSocketEndpointConfig
}

// Enhanced event types
export interface WebSocketEndpointEvents<In = unknown, Out = unknown> {
    connect: [ReferencedWebSocket<In, Out>];
    disconnect: [ReferencedWebSocket<In, Out>, number, string]; // socket, code, reason
    destroy: [];
    error: [Error, ReferencedWebSocket<In, Out>?];
    rateLimit: [IncomingMessage];
}

/**
 * @typeParam In - messages clients send to this endpoint
 * @typeParam Out - messages this endpoint sends to clients
 */
export class WebSocketEndpointController<In = unknown, Out = unknown> extends EventEmitter<WebSocketEndpointEvents<In, Out>> implements GenericWebSocketEndpointController {
    beforeUpgrade?: UpgradeHandler;

    private sockets = new Map<string, ReferencedWebSocket<In, Out>>();
    private pendingKeys = new Map<string, PendingKey>();
    private rateLimitMap = new Map<string, { count: number; resetTime: number }>();
    // Requests that passed authorize() before their handshake, so add() doesn't check (and count) them again.
    private authorized = new WeakSet<IncomingMessage>();
    private cleanupTimer?: NodeJS.Timeout;
    private heartbeatTimer?: NodeJS.Timeout;
    // Sockets pinged by the last heartbeat that haven't shown any sign of life since.
    private unanswered = new WeakSet<ReferencedWebSocket>();
    private destroyed = false;
    private readonly _config: WebSocketEndpointConfig;

    get authHandler() {
        return this.config.authHandler ?? (() => true);
    }

    get config() {
        return this._config;
    }

    /** The codec used by `sendMessage`, `onMessage` and `broadcastMessage`. */
    readonly codec: Codec;

    constructor(public readonly path: string, _config: WebSocketEndpointConfig) {
        super();
        this._config = {useConnectionKeys: true, ..._config};
        this.codec = resolveCodec(this._config.codec);

        this.cleanupTimer = setInterval(() => this.cleanupExpiredState(), 30000);
        this.cleanupTimer.unref?.();
    }

    private cleanupExpiredState(): void {
        const now = Date.now();
        for (const [id, pendingKey] of this.pendingKeys.entries()) {
            if (now > pendingKey.expiresAt) {
                this.pendingKeys.delete(id);
            }
        }
        for (const [clientId, limit] of this.rateLimitMap.entries()) {
            if (now > limit.resetTime) {
                this.rateLimitMap.delete(clientId);
            }
        }
    }

    /**
     * Emits `error` when someone is listening. An EventEmitter `error` event with no listener throws, which
     * would turn any client-side socket error into an uncaught exception and crash the server.
     * @internal
     */
    reportError(error: unknown, ws?: ReferencedWebSocket<In, Out>): void {
        const err = error instanceof Error ? error : new Error(String(error));
        if (this.listenerCount('error') > 0) {
            this.emit('error', err, ws);
        } else {
            console.error(`[sveltekit-websockets] ${this.path}:`, err);
        }
    }

    private generateConnectionKey(): string {
        // More secure, URL-safe key generation
        return randomBytes(32).toString('base64url');
    }

    /**
     * Checks the upgrade request's `Origin` header against `config.allowedOrigins`. A throwing custom check
     * counts as a rejection.
     */
    async isOriginAllowed(req: IncomingMessage): Promise<boolean> {
        const origin = req.headers.origin;
        if (!origin) return true;

        const allowed = this.config.allowedOrigins ?? 'same-origin';
        if (allowed === '*') return true;

        try {
            if (typeof allowed === 'function') return await allowed(origin, req);
            if (allowed === 'same-origin') return isSameOrigin(origin, req);
            const normalized = normalizeOrigin(origin);
            return normalized !== undefined && allowed.some((entry) => normalizeOrigin(entry) === normalized);
        } catch (error) {
            this.reportError(error);
            return false;
        }
    }

    /** Counts an attempt; returns the ms until the client may try again when it is over the limit. */
    private rateLimited(req: IncomingMessage): number | undefined {
        if (!this.config.rateLimit) return undefined;

        const clientId = this.config.rateLimit.key ? this.config.rateLimit.key(req) : rateLimitKey(clientAddress(req));
        // A custom key may exempt a request by returning undefined.
        if (clientId === undefined) return undefined;
        const now = Date.now();
        const limit = this.rateLimitMap.get(clientId);

        if (!limit || now > limit.resetTime) {
            this.rateLimitMap.set(clientId, {
                count: 1,
                resetTime: now + this.config.rateLimit.window
            });
            return undefined;
        }

        if (limit.count >= this.config.rateLimit.max) {
            this.emit('rateLimit', req);
            return limit.resetTime - now;
        }

        limit.count++;
        return undefined;
    }

    generatePendingConnectionKey(): string {
        const key = this.generateConnectionKey();
        const id = `pending_${Date.now()}_${randomBytes(8).toString('hex')}`;
        const expiresAt = Date.now() + (this.config.pendingKeyExpiration || 2 * 60 * 1000);

        this.pendingKeys.set(id, {
            key,
            createdAt: Date.now(),
            expiresAt
        });

        return key;
    }

    private validateConnectionKey(providedKey: string): boolean {
        if (!providedKey) return false;

        // Find and remove the matching pending key
        for (const [id, pendingKey] of this.pendingKeys.entries()) {
            if (pendingKey.key === providedKey && Date.now() <= pendingKey.expiresAt) {
                this.pendingKeys.delete(id);
                return true;
            }
        }
        return false;
    }

    /**
     * Runs every connection check on an upgrade request, in order: rate limit, `allowedOrigins`, `limit`,
     * connection key, `requiredParams`, `authHandler`. Resolves `undefined` when the request may connect,
     * otherwise why not. A valid connection key is consumed and the attempt counts against the rate limit.
     *
     * `WebSockets.upgrade` calls this before the handshake and answers a rejection with an HTTP response;
     * {@link add} then skips the checks for that request.
     */
    async authorize(req: IncomingMessage): Promise<UpgradeRejection | undefined> {
        try {
            const retryAfter = this.rateLimited(req);
            if (retryAfter !== undefined) {
                return {
                    status: 429,
                    code: WebSocketError.RATE_LIMITED,
                    reason: 'Rate limit exceeded',
                    headers: {'Retry-After': String(Math.max(1, Math.ceil(retryAfter / 1000)))}
                };
            }

            if (!await this.isOriginAllowed(req)) {
                return {status: 403, code: WebSocketError.ORIGIN_NOT_ALLOWED, reason: 'Origin not allowed'};
            }

            if (this.config.limit && this.sockets.size >= this.config.limit) {
                return {status: 503, code: WebSocketError.TOO_MANY_CONNECTIONS, reason: 'Too many connections'};
            }

            const params = parseUrl(req).searchParams;

            if (this.config.useConnectionKeys
                && !this.validateConnectionKey(connectionKey(req, this.config.allowKeyInQuery ?? true) ?? '')) {
                return {status: 403, code: WebSocketError.INVALID_KEY, reason: 'Invalid or expired connection key'};
            }

            for (const param of this.config.requiredParams ?? []) {
                if (!params.has(param)) {
                    return {status: 400, code: WebSocketError.MISSING_PARAM, reason: `Missing required parameter: ${param}`};
                }
            }

            if (!await this.authHandler(req)) {
                return {status: 401, code: WebSocketError.AUTH_FAILED, reason: 'Authentication failed'};
            }
        } catch (error) {
            this.reportError(error);
            return {status: 500, code: 1011, reason: 'Internal server error'};
        }

        this.authorized.add(req);
        return undefined;
    }

    /**
     * Registers an upgraded socket. Requests that didn't go through {@link authorize} first (e.g. sockets
     * upgraded by your own server code) are checked here and closed on rejection. Resolves `true` when the
     * socket was accepted, `false` when it was rejected (and closed).
     */
    async add(ws: ReferencedWebSocket<In, Out>, req: IncomingMessage): Promise<boolean> {
        try {
            if (!this.authorized.has(req)) {
                const rejection = await this.authorize(req);
                if (rejection) {
                    ws.close(rejection.code, rejection.reason);
                    return false;
                }
            }
            this.authorized.delete(req);

            // Other connections may have been accepted while this one was upgrading.
            if (this.config.limit && this.sockets.size >= this.config.limit) {
                ws.close(WebSocketError.TOO_MANY_CONNECTIONS, 'Too many connections');
                return false;
            }

            const params = parseUrl(req).searchParams;

            // Store parameters and add socket
            ws.params = Object.fromEntries(params.entries());
            ws.codec = this.codec;
            this.sockets.set(ws.ref, ws);
            this.watchHeartbeat(ws);

            // Setup timeout
            if (this.config.timeout && this.config.timeout > 0) {
                this.setupSocketTimeout(ws);
            }

            // Setup event listeners
            ws.once('close', (code: number, reason: Buffer) => {
                this.sockets.delete(ws.ref);
                if (this.sockets.size === 0) this.stopHeartbeat();
                if (ws.timeoutTimer) {
                    clearTimeout(ws.timeoutTimer);
                    ws.timeoutTimer = undefined;
                }
                this.emit('disconnect', ws, code, reason.toString());
            });

            ws.on('error', (error: Error) => {
                this.reportError(error, ws);
            });

            // Activity tracking. Pongs don't count: they answer the server's own heartbeat pings, which would
            // otherwise keep every idle connection alive forever.
            if (this.config.timeout && this.config.timeout > 0) {
                const activityHandler = () => this.resetSocketTimeout(ws);
                ws.on('message', activityHandler);
                ws.on('ping', activityHandler);
            }

            this.emit('connect', ws);
            return true;
        } catch (error) {
            this.reportError(error, ws);
            ws.close(1011, 'Internal server error');
            return false;
        }
    }

    /** The heartbeat interval in ms, or `undefined` when disabled. */
    private get heartbeatInterval(): number | undefined {
        const interval = this.config.heartbeat ?? DEFAULT_HEARTBEAT;
        return typeof interval === 'number' && interval > 0 ? interval : undefined;
    }

    private watchHeartbeat(ws: ReferencedWebSocket) {
        const interval = this.heartbeatInterval;
        if (!interval) return;
        // Any frame from the peer proves the connection is alive, not just a pong.
        const alive = () => this.unanswered.delete(ws);
        ws.on('pong', alive);
        ws.on('ping', alive);
        ws.on('message', alive);
        if (!this.heartbeatTimer) {
            this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
            this.heartbeatTimer.unref?.();
        }
    }

    /**
     * Pings every open socket and terminates the ones that haven't answered the previous ping. A peer that
     * vanished without a close frame (network drop, sleeping laptop, crashed client) is otherwise kept open
     * by the OS for a long time.
     */
    private heartbeat() {
        for (const ws of this.sockets.values()) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (this.unanswered.has(ws)) {
                ws.terminate();
                continue;
            }
            this.unanswered.add(ws);
            try {
                ws.ping();
            } catch (error) {
                this.reportError(error, ws);
            }
        }
    }

    private stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private setupSocketTimeout(ws: ReferencedWebSocket) {
        if (!this.config.timeout) return;

        if (ws.timeoutTimer) {
            clearTimeout(ws.timeoutTimer);
        }

        ws.timeoutTimer = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close(WebSocketError.TIMEOUT, 'Connection timeout due to inactivity');
            }
        }, this.config.timeout);

        ws.lastActivity = Date.now();
    }

    private resetSocketTimeout(ws: ReferencedWebSocket) {
        ws.lastActivity = Date.now();
        this.setupSocketTimeout(ws);
    }

    get new() {
        return `${this.path}` + (this.config.useConnectionKeys ? `?key=${this.generatePendingConnectionKey()}` : '');
    }

    /**
     * Encodes `message` once with the endpoint's codec and sends it to every open socket (or those
     * `filter` selects).
     */
    broadcastMessage(message: Out, options?: {
        filter?: (ws: ReferencedWebSocket<In, Out>) => boolean;
        compress?: boolean;
    }, cb?: (errors: Error[]) => void): void {
        this.broadcast(this.codec.encode(message), {...options, binary: false}, cb);
    }

    // Enhanced broadcast with error handling
    broadcast(data: BufferLike, options?: {
        mask?: boolean;
        binary?: boolean;
        compress?: boolean;
        fin?: boolean;
        filter?: (ws: ReferencedWebSocket<In, Out>) => boolean;
    }, cb?: (errors: Error[]) => void): void {
        const errors: Error[] = [];
        const sockets = options?.filter
            ? Array.from(this.sockets.values()).filter(options.filter)
            : Array.from(this.sockets.values());

        let completed = 0;
        const total = sockets.length;

        if (total === 0) {
            cb?.([]);
            return;
        }

        for (const socket of sockets) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(data, options ?? {}, (error) => {
                    if (error) errors.push(error);
                    completed++;
                    if (completed === total && cb) {
                        cb(errors);
                    }
                });
            } else {
                completed++;
                if (completed === total && cb) {
                    cb(errors);
                }
            }
        }
    }

    // Fixed send method
    send(ref: string, data: BufferLike, options?: {
        mask?: boolean | undefined;
        binary?: boolean | undefined;
        compress?: boolean | undefined;
        fin?: boolean | undefined;
    }, cb?: (err?: Error) => void): boolean {
        const socket = this.sockets.get(ref);
        if (!socket) {
            const error = new Error(`Socket not found: ${ref}`);
            if (cb) cb(error);
            return false;
        }

        if (socket.readyState !== WebSocket.OPEN) {
            const error = new Error(`Socket not ready: ${socket.readyState}`);
            if (cb) cb(error);
            return false;
        }

        try {
            socket.send(data, options ?? {}, cb);
            return true;
        } catch (error) {
            if (cb) cb(error as Error);
            return false;
        }
    }

    // Enhanced connection info
    getConnectionsInfo() {
        const connections = [];
        for (const [ref, socket] of this.sockets.entries()) {
            connections.push({
                ref,
                readyState: socket.readyState,
                params: socket.params,
                lastActivity: socket.lastActivity,
                connectedAt: socket.connectedAt,
                uptime: socket.uptime,
                idleTime: socket.lastActivity ? Date.now() - socket.lastActivity : undefined,
                metadata: socket.metadata
            });
        }
        return {
            connections,
            total: connections.length,
            pendingKeys: this.pendingKeys.size,
            rateLimitEntries: this.rateLimitMap.size
        };
    }

    // Graceful shutdown
    async gracefulShutdown(timeout: number = 5000): Promise<void> {
        return new Promise((resolve) => {
            const sockets = Array.from(this.sockets.values());
            let closedCount = 0;
            let forceTimeout: NodeJS.Timeout;

            if (sockets.length === 0) {
                resolve();
                return;
            }

            const finish = () => {
                clearTimeout(forceTimeout);
                resolve();
            };

            const closeHandler = () => {
                closedCount++;
                if (closedCount === sockets.length) {
                    finish();
                }
            };

            forceTimeout = setTimeout(() => {
                for (const socket of this.sockets.values()) {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.terminate();
                    }
                }
                resolve();
            }, timeout);

            // Gracefully close all connections
            for (const socket of sockets) {
                socket.once('close', closeHandler);
                if (socket.readyState === WebSocket.OPEN) {
                    socket.close(1001, 'Server shutting down');
                } else {
                    closeHandler();
                }
            }

            // Clear timeout if all connections close gracefully
            if (closedCount === sockets.length) {
                finish();
            }
        });
    }

    resetTimeout(ref: string): boolean {
        const socket = this.sockets.get(ref);
        if (!socket) return false;
        this.resetSocketTimeout(socket);
        return true;
    }

    terminate(ref?: string) {
        if (!ref) {
            for (const socket of this.sockets.values()) {
                if (socket.timeoutTimer) {
                    clearTimeout(socket.timeoutTimer);
                }
                socket.terminate();
            }
            this.sockets.clear();
            this.pendingKeys.clear();
            this.rateLimitMap.clear();
        } else {
            const socket = this.sockets.get(ref);
            if (!socket) throw new Error(`Socket not found: ${ref}`);
            if (socket.timeoutTimer) {
                clearTimeout(socket.timeoutTimer);
            }
            socket.terminate();
        }
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        this.stopHeartbeat();

        // Clear all timers and maps
        for (const socket of this.sockets.values()) {
            if (socket.timeoutTimer) {
                clearTimeout(socket.timeoutTimer);
            }
            if (socket.readyState === WebSocket.OPEN) {
                socket.terminate();
            }
        }

        this.sockets.clear();
        this.pendingKeys.clear();
        this.rateLimitMap.clear();
        this.config?.disposer?.();
        this.emit('destroy');
        this.removeAllListeners();
    }

    toJSON() {
        return {
            path: this.path,
            connectionCount: this.sockets.size,
            pendingKeysCount: this.pendingKeys.size,
            rateLimitEntries: this.rateLimitMap.size,
            timeout: this.config.timeout || 'none',
            uptime: Date.now() - (this.sockets.values().next().value?.connectedAt || Date.now())
        };
    }
}

// Enhanced configuration
/**
 * Which browser origins may open a connection:
 * - `'same-origin'` (default): the `Origin` host must match the request's `Host` or `X-Forwarded-Host`, or
 *   the `Origin` must equal the `ORIGIN` environment variable (as used by adapter-node)
 * - `'*'`: any origin
 * - a list of origins, e.g. `['https://app.example.com']`
 * - a function deciding per request
 *
 * Requests without an `Origin` header are always allowed: browsers send one on every WebSocket handshake,
 * so only non-browser clients (which cross-site WebSocket hijacking does not apply to) omit it.
 */
export type AllowedOrigins =
    | 'same-origin'
    | '*'
    | readonly string[]
    | ((origin: string, req: IncomingMessage) => MaybePromise<boolean>);

export type WebSocketEndpointConfig = {
    authHandler?: (req: IncomingMessage) => MaybePromise<boolean>;
    /**
     * Which browser origins may connect; rejected upgrades get HTTP 403. Default `'same-origin'`.
     * @see AllowedOrigins
     */
    allowedOrigins?: AllowedOrigins;
    limit?: number;
    useConnectionKeys?: boolean;
    pendingKeyExpiration?: number;
    requiredParams?: string[];
    /**
     * Idle timeout in ms: closes a connection that hasn't sent a message or ping for this long. Disabled by
     * default. Pongs (answers to the heartbeat) don't count as activity.
     */
    timeout?: number;
    /**
     * Ping interval in ms. A connection that hasn't answered the previous ping (or sent anything else) by the
     * next one is terminated, which emits `disconnect` with code `1006`. Default `30_000`; `false` or `0`
     * disables it.
     */
    heartbeat?: number | false;
    /**
     * Largest message, in bytes, a client may send. A bigger message closes the connection with `1009`.
     * Default `1_048_576` (1 MiB); `0` removes the limit.
     */
    maxPayload?: number;
    /**
     * Accept the connection key from the `?key=` query parameter as well as from the
     * `Sec-WebSocket-Protocol` header the bundled client uses. Query strings end up in access logs, so turn
     * this off once every client sends the key in the header. Default `true`.
     */
    allowKeyInQuery?: boolean;
    /**
     * How `sendMessage`, `onMessage` and `broadcastMessage` encode messages. Must match the client's
     * `codec`. Default `'json'`.
     */
    codec?: CodecOption;
    /**
     * Max connection attempts per client per window. Clients are told apart by IP address (see
     * {@link clientAddress}; IPv6 addresses share a limit per /64), or by `key` when given.
     */
    rateLimit?: {
        max: number;
        /** Window length in ms. */
        window: number;
        /** Identifies the client a request counts against. Return `undefined` to exempt a request. */
        key?: (req: IncomingMessage) => string | undefined;
    };
} & GenericWebSocketEndpointConfig;

// Rest of the implementation remains similar but with enhanced error handling
export class WebSocketRawEndpointController implements GenericWebSocketEndpointController {
    get config() {
        return this._config;
    }

    constructor(public readonly path: string, private readonly _config: GenericWebSocketEndpointConfig & {
        handle: UpgradeHandle
    }) {
    }

    async handle(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        try {
            await this._config.handle(req, socket, head);
        } catch (error) {
            socket.destroy(error as Error);
        }
    }

    destroy() {
        this._config.disposer?.();
    }
}

export type UseConnectionHandler<In = unknown, Out = unknown> =
    (ws: ReferencedWebSocket<In, Out>, controller: WebSocketEndpointController<In, Out>) => unknown;

/**
 * Backs `use()`. A route can serve many per-request connections at once, so every `use()` call gets its own
 * single-connection {@link WebSocketEndpointController}, registered here under its one-time connection key.
 * An upgrade is routed to the controller its `?key=` belongs to. A controller is released when its key
 * expires unused, when its handshake is rejected, or when its connection closes.
 */
export class WebSocketRequestEndpointController implements GenericWebSocketEndpointController {
    private readonly pending = new Map<string, { controller: WebSocketEndpointController, expiry: NodeJS.Timeout }>();
    private readonly active = new Set<WebSocketEndpointController>();

    constructor(public readonly path: string, private readonly _config: GenericWebSocketEndpointConfig) {
    }

    get config() {
        return this._config;
    }

    /** Number of unclaimed keys plus live connections. */
    get size() {
        return this.pending.size + this.active.size;
    }

    /**
     * Creates a single-connection controller and returns its connection URL.
     */
    create<In = unknown, Out = unknown>(connectionHandler: UseConnectionHandler<In, Out>, config?: Omit<WebSocketEndpointConfig, 'disposer' | 'limit' | 'path'>): string {
        const controller: WebSocketEndpointController<In, Out> = new WebSocketEndpointController<In, Out>(this.path, {
            ...config,
            limit: 1,
            // A key is what routes the upgrade to this controller, so `use()` endpoints always need one.
            useConnectionKeys: true,
            disposer: () => this.release(key, controller),
        });
        const key = controller.generatePendingConnectionKey();

        const expiry = setTimeout(() => controller.destroy(), controller.config.pendingKeyExpiration || 2 * 60 * 1000);
        expiry.unref?.();
        this.pending.set(key, {controller, expiry});

        controller.once('connect', (socket) => {
            socket.once('close', () => controller.destroy());
            // A synchronous throw is caught by `controller.add`, which closes the socket with 1011.
            const result = connectionHandler(socket, controller);
            if (result instanceof Promise) {
                result.catch((error) => controller.reportError(error, socket));
            }
        });

        return `${this.path}?key=${key}`;
    }

    /**
     * Takes the controller a connection key belongs to. A key can be claimed once; later upgrades with the same
     * key get nothing.
     */
    claim(key: string | null): WebSocketEndpointController | undefined {
        if (!key) return undefined;
        const entry = this.pending.get(key);
        if (!entry) return undefined;
        this.pending.delete(key);
        clearTimeout(entry.expiry);
        this.active.add(entry.controller);
        return entry.controller;
    }

    private release(key: string, controller: WebSocketEndpointController) {
        const entry = this.pending.get(key);
        if (entry?.controller === controller) {
            clearTimeout(entry.expiry);
            this.pending.delete(key);
        }
        this.active.delete(controller);
        if (this.size === 0) {
            this._config.disposer?.();
        }
    }

    private controllers() {
        return [...Array.from(this.pending.values(), (entry) => entry.controller), ...this.active];
    }

    async gracefulShutdown(timeout?: number): Promise<void> {
        await Promise.all(Array.from(this.active, (controller) => controller.gracefulShutdown(timeout)));
    }

    destroy() {
        for (const controller of this.controllers()) {
            controller.destroy();
        }
        this.pending.clear();
        this.active.clear();
        this._config.disposer?.();
    }
}

function parseUrl(req: IncomingMessage): URL {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

/** `scheme://host[:port]` with default ports dropped and the host lowercased, or `undefined` if invalid. */
function normalizeOrigin(origin: string): string | undefined {
    try {
        const url = new URL(origin);
        return url.origin === 'null' ? undefined : url.origin;
    } catch {
        return undefined;
    }
}

/**
 * Same-origin check for an upgrade request. Only the host is compared, not the scheme, since a TLS-terminating
 * proxy turns `https` into a plain request. A cross-site page can't forge `Host` or `X-Forwarded-Host`: the
 * browser sets `Host` to the target server and a page can't add headers to a WebSocket handshake.
 */
function isSameOrigin(origin: string, req: IncomingMessage): boolean {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    if (url.origin === 'null') return false;

    const envOrigin = process.env.ORIGIN ? normalizeOrigin(process.env.ORIGIN) : undefined;
    if (envOrigin && envOrigin === url.origin) return true;

    const forwarded = req.headers['x-forwarded-host'];
    const hosts = [
        req.headers.host,
        ...(Array.isArray(forwarded) ? forwarded : [forwarded]).flatMap((value) => value?.split(',') ?? [])
    ];
    return hosts.some((host) => {
        if (!host?.trim()) return false;
        try {
            // Parse with the origin's scheme so a default port written out (`host:443`) compares equal.
            return new URL(`${url.protocol}//${host.trim()}`).host === url.host;
        } catch {
            return false;
        }
    });
}

function routePath(route: string | RequestEventLike | URL): string {
    if (typeof route === 'string') return route;
    if (route instanceof URL) return route.pathname;
    return route.url.pathname;
}

/**
 * Rejects an upgrade request with a plain HTTP response. `code` must be an HTTP error status (`400`–`599`);
 * anything else (such as a WebSocket close code) is sent as `400`.
 */
function rejectUpgrade(socket: Duplex, code: number, reason: string, headers: Record<string, string> = {}) {
    const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 400;
    // The reason becomes the response body; strip line breaks so it can't inject headers.
    const body = String(reason ?? '').replace(/[\r\n]+/g, ' ');
    if (!socket.writable) {
        socket.destroy();
        return;
    }
    socket.once('finish', () => socket.destroy());
    socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        Object.entries(headers).map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]+/g, ' ')}\r\n`).join('') +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
}

const allowed_routes = new Map<string, GenericWebSocketEndpointController>();

// `maxPayload` is a server-level option in `ws`, so there is one (cheap, port-less) server per limit in use.
const createServer = (maxPayload: number) => new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload,
    WebSocket: ReferencedWebSocket,
    // Answer with the client's first protocol that doesn't carry a connection key, so the key is never
    // echoed back. (A browser fails the handshake unless one of its offered protocols is selected.)
    handleProtocols: (protocols) => {
        for (const protocol of protocols) {
            if (!protocol.startsWith(KEY_PROTOCOL_PREFIX)) return protocol;
        }
        return false;
    },
});
const servers = new Map<number, ReturnType<typeof createServer>>();
const serverFor = (maxPayload: number = DEFAULT_MAX_PAYLOAD) => {
    const limit = Number.isFinite(maxPayload) && maxPayload > 0 ? Math.floor(maxPayload) : 0;
    let server = servers.get(limit);
    if (!server) {
        server = createServer(limit);
        servers.set(limit, server);
    }
    return server;
};

/** Removes a route only if it still belongs to `controller` (a newer controller may have taken the path). */
const unregister = (path: string, controller: GenericWebSocketEndpointController) => {
    if (allowed_routes.get(path) === controller) {
        allowed_routes.delete(path);
    }
};

const alreadyRegistered = (path: string, by: GenericWebSocketEndpointController) => {
    const kind = by instanceof WebSocketRequestEndpointController ? 'use()'
        : by instanceof WebSocketRawEndpointController ? 'raw()'
            : 'continuous()';
    return new Error(`sveltekit-websockets: "${path}" is already registered by ${kind}`);
};

export const WebSockets = {
    /**
     * Registers (or returns the existing) long-lived endpoint for a route.
     * @throws when the route is already registered by `use()` or `raw()`
     */
    continuous<In = unknown, Out = unknown>(route: string | RequestEventLike | URL, config?: Omit<WebSocketEndpointConfig, 'disposer' | "path">): WebSocketEndpointController<In, Out> {
        const path = routePath(route);
        const existing = allowed_routes.get(path);
        if (existing) {
            if (existing instanceof WebSocketEndpointController) return existing as WebSocketEndpointController<In, Out>;
            throw alreadyRegistered(path, existing);
        }
        const controller: WebSocketEndpointController<In, Out> = new WebSocketEndpointController<In, Out>(path, {
            ...config,
            disposer: () => unregister(path, controller),
        });
        allowed_routes.set(path, controller);
        return controller;
    },

    /**
     * Creates a single-use endpoint for one connection and returns its URL (with a one-time `?key=`).
     * Every call gets its own controller and handler, so concurrent requests to the same route are isolated.
     * `useConnectionKeys: false` is ignored: the key is what routes the connection to this call's handler.
     * @throws when the route is already registered by `continuous()` or `raw()`
     */
    use<In = unknown, Out = unknown>(route: string | RequestEventLike | URL, connectionHandler: UseConnectionHandler<In, Out>, config?: Omit<WebSocketEndpointConfig, 'disposer' | 'limit' | 'path'>): string {
        const path = routePath(route);
        let endpoint = allowed_routes.get(path);
        if (!endpoint) {
            const requests: WebSocketRequestEndpointController = new WebSocketRequestEndpointController(path, {
                disposer: () => unregister(path, requests),
            });
            allowed_routes.set(path, requests);
            endpoint = requests;
        }
        if (!(endpoint instanceof WebSocketRequestEndpointController)) {
            throw alreadyRegistered(path, endpoint);
        }
        return endpoint.create(connectionHandler, config);
    },

    raw(route: string | RequestEventLike | URL, handle: UpgradeHandle) {
        const path = routePath(route);
        if (!allowed_routes.has(path)) {
            const controller: WebSocketRawEndpointController = new WebSocketRawEndpointController(path, {
                handle,
                disposer: () => unregister(path, controller),
            });
            allowed_routes.set(path, controller)
        }
    },

    /**
     * Unregisters every route and closes every connection with `1001`, force-terminating sockets still open
     * after `timeout` ms. The generated production entry calls this when the HTTP server starts closing
     * (SIGINT/SIGTERM on adapter-node); call it yourself from a custom server's shutdown.
     */
    async shutdown(timeout: number = 5000): Promise<void> {
        const controllers = Array.from(allowed_routes.values());
        allowed_routes.clear();
        await Promise.all(controllers.map(async (controller) => {
            try {
                await controller.gracefulShutdown?.(timeout);
            } finally {
                controller.destroy();
            }
        }));
    },

    /**
     * Same as {@link WebSockets.shutdown} with the default timeout.
     */
    clear(): Promise<void> {
        return WebSockets.shutdown();
    },

    /**
     * Whether a route is registered for this upgrade request. Lets a server that has other `'upgrade'`
     * listeners (Vite's HMR, Vitest's browser runner) leave requests it doesn't own alone.
     */
    handles(req: IncomingMessage): boolean {
        return allowed_routes.has(parseUrl(req).pathname);
    },

    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
        // Node drops its own 'error' listener from an upgraded socket. Without one, a client resetting the
        // connection while an async check (authHandler, beforeUpgrade) is pending would crash the process.
        // Removed again once `ws` takes the socket over, since it installs its own.
        const onSocketError = () => socket.destroy();
        socket.on('error', onSocketError);
        const handOver = () => socket.off('error', onSocketError);
        // The client went away while a check was pending.
        const gone = () => socket.destroyed || !socket.writable;

        try {
            const url = parseUrl(req);
            const controller = allowed_routes.get(url.pathname);
            if (!controller) {
                rejectUpgrade(socket, 404, 'No WebSocket endpoint at this path');
                return;
            }
            if (controller instanceof WebSocketEndpointController) {
                const rejection = await controller.authorize(req);
                if (rejection) {
                    rejectUpgrade(socket, rejection.status, rejection.reason, rejection.headers);
                    return;
                }
                if (!controller.beforeUpgrade) {
                    controller.beforeUpgrade = ({accept}) => accept();
                }
                await controller.beforeUpgrade({
                    req, head,
                    accept: () => {
                        if (gone()) {
                            socket.destroy();
                            return;
                        }
                        handOver();
                        serverFor(controller.config.maxPayload)
                            .handleUpgrade(req, socket, head, (ws, req) => controller.add(ws, req));
                    },
                    decline: (reason, code = 400) => rejectUpgrade(socket, code, reason)
                });
            } else if (controller instanceof WebSocketRequestEndpointController) {
                const endpoint = controller.claim(connectionKey(req) ?? null);
                if (!endpoint) {
                    rejectUpgrade(socket, 403, 'Invalid or expired connection key');
                    return;
                }
                const rejection = await endpoint.authorize(req);
                if (rejection || gone()) {
                    endpoint.destroy();
                    if (rejection) rejectUpgrade(socket, rejection.status, rejection.reason, rejection.headers);
                    else socket.destroy();
                    return;
                }
                // Release the endpoint if the client goes away before the handshake completes.
                let upgraded = false;
                socket.once('close', () => {
                    if (!upgraded) endpoint.destroy();
                });
                handOver();
                serverFor(endpoint.config.maxPayload).handleUpgrade(req, socket, head, async (ws, req) => {
                    upgraded = true;
                    if (!await endpoint.add(ws, req)) {
                        endpoint.destroy();
                    }
                });
            } else if (controller instanceof WebSocketRawEndpointController) {
                handOver();
                await controller.handle(req, socket, head);
            }
        } catch (error) {
            socket.destroy(error as Error);
        }
    },
};

if (!globalThis.websockets) {
    globalThis.websockets = WebSockets;
}

export const websockets = globalThis.websockets;

export default websockets;

