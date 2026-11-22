import {WebSocketServer, WebSocket} from 'ws';
import type {Duplex} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {STATUS_CODES} from 'node:http';
import {randomBytes, randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";

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

// Enhanced socket with better metadata tracking
export class ReferencedWebSocket extends WebSocket {
    private _ref: string = randomUUID();
    private _connectedAt: number = Date.now();

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
    TIMEOUT: 1001,
    RATE_LIMITED: 1013
} as const;

export type WebSocketError = typeof WebSocketError[keyof typeof WebSocketError];

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
export interface WebSocketEndpointEvents {
    connect: [ReferencedWebSocket];
    disconnect: [ReferencedWebSocket, number, string]; // socket, code, reason
    destroy: [];
    error: [Error, ReferencedWebSocket?];
    rateLimit: [IncomingMessage];
}

export class WebSocketEndpointController extends EventEmitter<WebSocketEndpointEvents> implements GenericWebSocketEndpointController {
    beforeUpgrade?: UpgradeHandler;

    private sockets = new Map<string, ReferencedWebSocket>();
    private pendingKeys = new Map<string, PendingKey>();
    private rateLimitMap = new Map<string, { count: number; resetTime: number }>();
    private cleanupTimer?: NodeJS.Timeout;
    private destroyed = false;
    private readonly _config: WebSocketEndpointConfig;

    get authHandler() {
        return this.config.authHandler ?? (() => true);
    }

    get config() {
        return this._config;
    }

    constructor(public readonly path: string, _config: WebSocketEndpointConfig) {
        super();
        this._config = {useConnectionKeys: true, ..._config};

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
    reportError(error: unknown, ws?: ReferencedWebSocket): void {
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

    private checkRateLimit(req: IncomingMessage): boolean {
        if (!this.config.rateLimit) return true;

        const clientId = this.getClientId(req);
        const now = Date.now();
        const limit = this.rateLimitMap.get(clientId);

        if (!limit || now > limit.resetTime) {
            this.rateLimitMap.set(clientId, {
                count: 1,
                resetTime: now + this.config.rateLimit.window
            });
            return true;
        }

        if (limit.count >= this.config.rateLimit.max) {
            this.emit('rateLimit', req);
            return false;
        }

        limit.count++;
        return true;
    }

    private getClientId(req: IncomingMessage): string {
        // Use IP + User-Agent for basic client identification
        const ip = req.socket.remoteAddress || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        return `${ip}:${userAgent}`;
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
     * Validates and registers an upgraded socket. Resolves `true` when the socket was accepted, `false`
     * when it was rejected (and closed).
     */
    async add(ws: ReferencedWebSocket, req: IncomingMessage): Promise<boolean> {
        try {
            // Rate limiting check
            if (!this.checkRateLimit(req)) {
                ws.close(WebSocketError.RATE_LIMITED, 'Rate limit exceeded');
                return false;
            }

            // Connection limit check
            if (this.config?.limit && this.sockets.size >= this.config.limit) {
                ws.close(WebSocketError.TOO_MANY_CONNECTIONS, 'Too many connections');
                return false;
            }

            const params = parseUrl(req)?.searchParams;

            // Key validation
            if (this.config.useConnectionKeys) {
                const providedKey = params.get('key');
                if (!this.validateConnectionKey(providedKey || '')) {
                    ws.close(WebSocketError.INVALID_KEY, 'Invalid or expired connection key');
                    return false;
                }
            }

            // Required parameters check
            if (this.config.requiredParams) {
                for (const param of this.config.requiredParams) {
                    if (!params.has(param)) {
                        ws.close(WebSocketError.MISSING_PARAM, `Missing required parameter: ${param}`);
                        return false;
                    }
                }
            }

            // Authentication
            if (!await this.authHandler(req)) {
                ws.close(WebSocketError.AUTH_FAILED, 'Authentication failed');
                return false;
            }

            // Store parameters and add socket
            ws.params = Object.fromEntries(params.entries());
            this.sockets.set(ws.ref, ws);

            // Setup timeout
            if (this.config.timeout && this.config.timeout > 0) {
                this.setupSocketTimeout(ws);
            }

            // Setup event listeners
            ws.once('close', (code: number, reason: Buffer) => {
                this.sockets.delete(ws.ref);
                if (ws.timeoutTimer) {
                    clearTimeout(ws.timeoutTimer);
                    ws.timeoutTimer = undefined;
                }
                this.emit('disconnect', ws, code, reason.toString());
            });

            ws.on('error', (error: Error) => {
                this.reportError(error, ws);
            });

            // Activity tracking
            if (this.config.timeout && this.config.timeout > 0) {
                const activityHandler = () => this.resetSocketTimeout(ws);
                ws.on('message', activityHandler);
                ws.on('ping', activityHandler);
                ws.on('pong', activityHandler);
            }

            this.emit('connect', ws);
            return true;
        } catch (error) {
            this.reportError(error, ws);
            ws.close(1011, 'Internal server error');
            return false;
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

    // Enhanced broadcast with error handling
    broadcast(data: BufferLike, options?: {
        mask?: boolean;
        binary?: boolean;
        compress?: boolean;
        fin?: boolean;
        filter?: (ws: ReferencedWebSocket) => boolean;
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
export type WebSocketEndpointConfig = {
    authHandler?: (req: IncomingMessage) => MaybePromise<boolean>;
    limit?: number;
    useConnectionKeys?: boolean;
    pendingKeyExpiration?: number;
    requiredParams?: string[];
    timeout?: number;
    rateLimit?: {
        max: number;
        window: number; // in milliseconds
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

export type UseConnectionHandler = (ws: ReferencedWebSocket, controller: WebSocketEndpointController) => unknown;

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
    create(connectionHandler: UseConnectionHandler, config?: Omit<WebSocketEndpointConfig, 'disposer' | 'limit' | 'path'>): string {
        const controller: WebSocketEndpointController = new WebSocketEndpointController(this.path, {
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

function routePath(route: string | RequestEventLike | URL): string {
    if (typeof route === 'string') return route;
    if (route instanceof URL) return route.pathname;
    return route.url.pathname;
}

/**
 * Rejects an upgrade request with a plain HTTP response. `code` must be an HTTP error status (`400`–`599`);
 * anything else (such as a WebSocket close code) is sent as `400`.
 */
function rejectUpgrade(socket: Duplex, code: number, reason: string) {
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
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
}

const allowed_routes = new Map<string, GenericWebSocketEndpointController>();
const server = new WebSocketServer({noServer: true, WebSocket: ReferencedWebSocket});

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
    continuous(route: string | RequestEventLike | URL, config?: Omit<WebSocketEndpointConfig, 'disposer' | "path">) {
        const path = routePath(route);
        const existing = allowed_routes.get(path);
        if (existing) {
            if (existing instanceof WebSocketEndpointController) return existing;
            throw alreadyRegistered(path, existing);
        }
        const controller: WebSocketEndpointController = new WebSocketEndpointController(path, {
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
    use(route: string | RequestEventLike | URL, connectionHandler: UseConnectionHandler, config?: Omit<WebSocketEndpointConfig, 'disposer' | 'limit' | 'path'>): string {
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
        try {
            const url = parseUrl(req);
            const controller = allowed_routes.get(url.pathname);
            if (!controller) {
                socket.end();
                return;
            }
            if (controller instanceof WebSocketEndpointController) {
                if (!controller.beforeUpgrade) {
                    controller.beforeUpgrade = ({accept}) => accept();
                }
                await controller.beforeUpgrade({
                    req, head,
                    accept: () => server.handleUpgrade(req, socket, head, (ws, req) => controller.add(ws, req)),
                    decline: (reason, code = 400) => rejectUpgrade(socket, code, reason)
                });
            } else if (controller instanceof WebSocketRequestEndpointController) {
                const endpoint = controller.claim(url.searchParams.get('key'));
                server.handleUpgrade(req, socket, head, async (ws, req) => {
                    if (!endpoint) {
                        ws.close(WebSocketError.INVALID_KEY, 'Invalid or expired connection key');
                        return;
                    }
                    if (!await endpoint.add(ws, req)) {
                        endpoint.destroy();
                    }
                });
            } else if (controller instanceof WebSocketRawEndpointController) {
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

