import {WebSocketServer, WebSocket} from 'ws';
import type {Duplex} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {randomBytes, randomUUID} from "node:crypto";
import type {RequestEvent} from "@sveltejs/kit";
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

type MaybePromise<T> = T | Promise<T>;

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

    get ref() {
        return this._ref;
    }

    get connectedAt() {
        return this._connectedAt;
    }

    get uptime() {
        return Date.now() - this._connectedAt;
    }
}

// Enhanced pending key tracking
interface PendingKey {
    key: string;
    createdAt: number;
    expiresAt: number;
}

// Better error types
export enum WebSocketError {
    TOO_MANY_CONNECTIONS = 1013,
    INVALID_KEY = 1008,
    MISSING_PARAM = 1008,
    AUTH_FAILED = 1008,
    TIMEOUT = 1001,
    RATE_LIMITED = 1013
}

export type UpgradeHandler = (input: {
    req: IncomingMessage,
    head: Buffer,
    accept: () => MaybePromise<unknown>,
    decline: (reason: string, code?: number) => unknown
}) => MaybePromise<any>;

export type UpgradeHandle = (req: IncomingMessage, socket: Duplex, head: Buffer) => MaybePromise<any>;

export type GenericWebSocketEndpointConfig = {
    disposer?: () => void;
}

export interface GenericWebSocketEndpointController {
    destroy(): void;

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

    get authHandler() {
        return this.config.authHandler ?? (() => true);
    }

    get config() {
        return this._config;
    }

    constructor(public readonly path: string, private readonly _config: WebSocketEndpointConfig) {
        super();
        if (this.config.useConnectionKeys === undefined) this.config.useConnectionKeys = true;

        // Clean up expired pending keys periodically
        setInterval(() => this.cleanupExpiredKeys(), 30000); // Every 30 seconds
    }

    private cleanupExpiredKeys(): void {
        const now = Date.now();
        for (const [id, pendingKey] of this.pendingKeys.entries()) {
            if (now > pendingKey.expiresAt) {
                this.pendingKeys.delete(id);
            }
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

    async add(ws: ReferencedWebSocket, req: IncomingMessage) {
        try {
            // Rate limiting check
            if (!this.checkRateLimit(req)) {
                ws.close(WebSocketError.RATE_LIMITED, 'Rate limit exceeded');
                return;
            }

            // Connection limit check
            if (this.config?.limit && this.sockets.size >= this.config.limit) {
                ws.close(WebSocketError.TOO_MANY_CONNECTIONS, 'Too many connections');
                return;
            }

            const params = parseUrl(req)?.searchParams;

            // Key validation
            if (this.config.useConnectionKeys) {
                const providedKey = params.get('key');
                if (!this.validateConnectionKey(providedKey || '')) {
                    ws.close(WebSocketError.INVALID_KEY, 'Invalid or expired connection key');
                    return;
                }
            }

            // Required parameters check
            if (this.config.requiredParams) {
                for (const param of this.config.requiredParams) {
                    if (!params.has(param)) {
                        ws.close(WebSocketError.MISSING_PARAM, `Missing required parameter: ${param}`);
                        return;
                    }
                }
            }

            // Authentication
            if (!await this.authHandler(req)) {
                ws.close(WebSocketError.AUTH_FAILED, 'Authentication failed');
                return;
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
                this.emit('error', error, ws);
            });

            // Activity tracking
            if (this.config.timeout && this.config.timeout > 0) {
                const activityHandler = () => this.resetSocketTimeout(ws);
                ws.on('message', activityHandler);
                ws.on('ping', activityHandler);
                ws.on('pong', activityHandler);
            }

            this.emit('connect', ws);
        } catch (error) {
            this.emit('error', error as Error, ws);
            ws.close(1011, 'Internal server error');
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

            if (sockets.length === 0) {
                resolve();
                return;
            }

            const closeHandler = () => {
                closedCount++;
                if (closedCount === sockets.length) {
                    resolve();
                }
            };

            // Set timeout for forced termination
            const forceTimeout = setTimeout(() => {
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
                clearTimeout(forceTimeout);
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

function parseUrl(req: IncomingMessage): URL {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

const allowed_routes = new Map<string, GenericWebSocketEndpointController>();
const server = new WebSocketServer({noServer: true, WebSocket: ReferencedWebSocket});

export const WebSockets = {
    continuous(route: string | RequestEvent | URL, config?: Omit<WebSocketEndpointConfig, 'disposer' | "path">) {
        let path: string;
        if (typeof route === 'string') {
            path = route;
        } else if (route instanceof URL) {
            path = route.pathname;
        } else {
            path = route.url.pathname
        }
        if (!allowed_routes.has(path)) {
            allowed_routes.set(path, new WebSocketEndpointController(path, {
                ...config,
                disposer: () => allowed_routes.delete(path),
            }));
        }
        return (allowed_routes.get(path) as WebSocketEndpointController)!;
    },

    use(route: string | RequestEvent | URL, connectionHandler: (ws: ReferencedWebSocket, controller: WebSocketEndpointController) => unknown, config?: Omit<WebSocketEndpointConfig, 'disposer' | 'limit' | 'path'>) {
        let path: string;
        if (typeof route === 'string') path = route;
        else if (route instanceof URL) path = route.pathname;
        else path = route.url.pathname

        if (!allowed_routes.has(path)) {
            const controller = new WebSocketEndpointController(path, {
                ...config,
                limit: 1,
                disposer: () => allowed_routes.delete(path),
            });
            allowed_routes.set(path, controller);
            controller.once('connect', (socket) => {
                socket.once('close', () => controller.destroy())
                connectionHandler(socket, controller)
            })
        }
        return (allowed_routes.get(path) as WebSocketEndpointController)!.new;
    },

    raw(route: string | RequestEvent | URL, handle: UpgradeHandle) {
        let path: string;
        if (typeof route === 'string') path = route;
        else if (route instanceof URL) path = route.pathname;
        else path = route.url.pathname
        if (!allowed_routes.has(path)) {
            const controller = new WebSocketRawEndpointController(path, {handle});
            allowed_routes.set(path, controller)
        }
    },

    clear() {
        const controllers = Array.from(allowed_routes.values());
        allowed_routes.clear();
        // Graceful shutdown for all controllers
        Promise.all(controllers.map(async (controller) => {
            if (controller instanceof WebSocketEndpointController) {
                await controller.gracefulShutdown();
            }
            controller.destroy();
        })).finally(() => console.debug("Closed all controllers"))
    },

    async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
        try {
            const path = parseUrl(req).pathname;
            if (!allowed_routes.has(path)) {
                socket.end();
                return;
            }
            const controller = allowed_routes.get(path)!;
            if (controller instanceof WebSocketEndpointController) {
                if (!controller.beforeUpgrade) {
                    controller.beforeUpgrade = ({accept}) => accept();
                }
                await controller.beforeUpgrade({
                    req, head,
                    accept: () => server.handleUpgrade(req, socket, head, (ws, req) => controller.add(ws, req)),
                    decline: (reason, code = 1002) => {
                        socket.write(`HTTP/1.1 ${code} ${reason}\r\n\r\n`);
                        socket.destroy();
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

export default websockets = globalThis.websockets;
