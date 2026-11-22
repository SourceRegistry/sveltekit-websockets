import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {WebSocket as WsClient} from 'ws';
import {WebSocketError, WebSockets} from './index.js';

let httpServer: Server;
let port: number;

beforeAll(async () => {
    httpServer = createServer();
    httpServer.on('upgrade', (req, socket, head) => WebSockets.upgrade(req, socket, head));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
    await WebSockets.shutdown(100);
});

afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
});

const connect = (path: string) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`);
    ws.on('error', () => {});
    const firstMessage = new Promise<string>((resolve) => ws.once('message', (data) => resolve(data.toString())));
    const closed = new Promise<{ code: number, reason: string }>((resolve) =>
        ws.on('close', (code, reason) => resolve({code, reason: reason.toString()})));
    const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()));
    return {ws, firstMessage, closed, opened};
};

const rejection = (path: string) => new Promise<{ status: number, body: string }>((resolve) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`);
    ws.on('error', () => {});
    ws.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            resolve({status: res.statusCode ?? 0, body});
            req.destroy();
        });
    });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('use()', () => {
    it('gives every call on the same route its own handler', async () => {
        const urlA = WebSockets.use('/same-route', (socket) => socket.send('A'));
        const urlB = WebSockets.use('/same-route', (socket) => socket.send('B'));

        expect(urlA).not.toBe(urlB);

        // Connect in reverse order: each key must reach the handler of the call that minted it.
        const b = connect(urlB);
        const a = connect(urlA);
        expect(await b.firstMessage).toBe('B');
        expect(await a.firstMessage).toBe('A');

        a.ws.close();
        b.ws.close();
    });

    it('serves concurrent connections on the same route', async () => {
        const handled: string[] = [];
        const urls = ['one', 'two', 'three'].map((name) =>
            WebSockets.use('/concurrent', (socket) => {
                handled.push(name);
                socket.send(name);
            }));

        const clients = urls.map(connect);
        const messages = await Promise.all(clients.map((client) => client.firstMessage));

        expect(messages).toEqual(['one', 'two', 'three']);
        expect(handled.sort()).toEqual(['one', 'three', 'two']);
        clients.forEach((client) => client.ws.close());
    });

    it('accepts a connection key only once', async () => {
        const url = WebSockets.use('/single-use', (socket) => socket.send('hi'));
        const keep = WebSockets.use('/single-use', () => {});

        const first = connect(url);
        expect(await first.firstMessage).toBe('hi');

        const second = connect(url);
        expect((await second.closed).code).toBe(WebSocketError.INVALID_KEY);

        first.ws.close();
        expect(keep).toContain('?key=');
    });

    it('drops an unused key after pendingKeyExpiration', async () => {
        const handler = vi.fn();
        const expired = WebSockets.use('/expiry', handler, {pendingKeyExpiration: 20});
        WebSockets.use('/expiry', () => {}); // keeps the route registered

        await sleep(60);

        const client = connect(expired);
        expect((await client.closed).code).toBe(WebSocketError.INVALID_KEY);
        expect(handler).not.toHaveBeenCalled();
    });

    it('releases the route once every connection is gone', async () => {
        const url = WebSockets.use('/released', (socket) => socket.send('x'));
        const client = connect(url);
        await client.firstMessage;
        client.ws.close();
        await client.closed;
        await sleep(20);

        expect(() => WebSockets.continuous('/released')).not.toThrow();
    });

    it('releases the controller when the handshake is rejected', async () => {
        const handler = vi.fn();
        const url = WebSockets.use('/rejected', handler, {authHandler: () => false});

        const client = connect(url);
        expect((await client.closed).code).toBe(WebSocketError.AUTH_FAILED);
        expect(handler).not.toHaveBeenCalled();
        expect(() => WebSockets.continuous('/rejected')).not.toThrow();
    });

    it('closes with 1011 instead of crashing when the handler throws', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const url = WebSockets.use('/throws', () => {
                throw new Error('boom');
            });
            const client = connect(url);
            expect((await client.closed).code).toBe(1011);
            expect(consoleError).toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('refuses a route already registered by continuous()', () => {
        WebSockets.continuous('/taken');
        expect(() => WebSockets.use('/taken', () => {})).toThrow(/continuous\(\)/);
    });
});

describe('continuous()', () => {
    it('refuses a route already registered by use()', () => {
        WebSockets.use('/taken-by-use', () => {});
        expect(() => WebSockets.continuous('/taken-by-use')).toThrow(/use\(\)/);
    });
});

describe('beforeUpgrade decline()', () => {
    it('sends the given HTTP status and the reason as body', async () => {
        WebSockets.continuous('/decline', {useConnectionKeys: false}).beforeUpgrade =
            ({decline}) => decline('not allowed', 403);

        expect(await rejection('/decline')).toEqual({status: 403, body: 'not allowed'});
    });

    it('defaults to 400', async () => {
        WebSockets.continuous('/decline-default', {useConnectionKeys: false}).beforeUpgrade =
            ({decline}) => decline('bad');

        expect((await rejection('/decline-default')).status).toBe(400);
    });

    it('sends 400 for a WebSocket close code and strips line breaks from the reason', async () => {
        WebSockets.continuous('/decline-close-code', {useConnectionKeys: false}).beforeUpgrade =
            ({decline}) => decline('bad\r\nX-Injected: 1', WebSocketError.AUTH_FAILED);

        expect(await rejection('/decline-close-code')).toEqual({status: 400, body: 'bad X-Injected: 1'});
    });
});

describe('shutdown()', () => {
    it('closes every connection with 1001 and unregisters every route', async () => {
        WebSockets.continuous('/shutdown', {useConnectionKeys: false});
        const perRequest = WebSockets.use('/shutdown-use', () => {});

        const a = connect('/shutdown');
        const b = connect(perRequest);
        await Promise.all([a.opened, b.opened]);

        await WebSockets.shutdown();

        expect((await a.closed).code).toBe(1001);
        expect((await b.closed).code).toBe(1001);
        expect(() => WebSockets.use('/shutdown', () => {})).not.toThrow();
    });

    it('lets httpServer.close() finish once the sockets are gone', async () => {
        const server = createServer();
        server.on('upgrade', (req, socket, head) => WebSockets.upgrade(req, socket, head));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const serverPort = (server.address() as AddressInfo).port;

        WebSockets.continuous('/close-wait', {useConnectionKeys: false});
        const ws = new WsClient(`ws://127.0.0.1:${serverPort}/close-wait`);
        ws.on('error', () => {});
        await new Promise((resolve) => ws.once('open', resolve));

        let closedAt = 0;
        const closed = new Promise<void>((resolve) => server.close(() => {
            closedAt = Date.now();
            resolve();
        }));
        const start = Date.now();
        await WebSockets.shutdown(1000);
        await closed;

        expect(closedAt - start).toBeLessThan(1000);
    });
});

describe('WebSocketError', () => {
    it('keeps every name, including the ones sharing a code', () => {
        expect(WebSocketError).toEqual({
            TOO_MANY_CONNECTIONS: 1013,
            INVALID_KEY: 1008,
            MISSING_PARAM: 1008,
            AUTH_FAILED: 1008,
            TIMEOUT: 1001,
            RATE_LIMITED: 1013
        });
    });
});

describe('allowedOrigins', () => {
    // Resolves with 101 when the handshake succeeds, otherwise the HTTP status of the rejection.
    const handshake = (path: string, options: { origin?: string, headers?: Record<string, string> } = {}) =>
        new Promise<number>((resolve) => {
            const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, options);
            ws.on('error', () => {});
            ws.on('open', () => {
                resolve(101);
                ws.close();
            });
            ws.on('unexpected-response', (req, res) => {
                resolve(res.statusCode ?? 0);
                req.destroy();
            });
        });

    const self = () => `http://127.0.0.1:${port}`;

    it('defaults to same-origin and allows requests without an Origin header', async () => {
        WebSockets.continuous('/origin-default', {useConnectionKeys: false});

        expect(await handshake('/origin-default')).toBe(101);
        expect(await handshake('/origin-default', {origin: self()})).toBe(101);
        expect(await handshake('/origin-default', {origin: 'http://evil.test'})).toBe(403);
        expect(await handshake('/origin-default', {origin: 'null'})).toBe(403);
    });

    it('matches X-Forwarded-Host, including an explicit default port', async () => {
        WebSockets.continuous('/origin-forwarded', {useConnectionKeys: false});

        expect(await handshake('/origin-forwarded', {
            origin: 'https://app.example.com',
            headers: {'x-forwarded-host': 'app.example.com'}
        })).toBe(101);
        expect(await handshake('/origin-forwarded', {
            origin: 'https://app.example.com',
            headers: {'x-forwarded-host': 'app.example.com:443'}
        })).toBe(101);
        expect(await handshake('/origin-forwarded', {
            origin: 'https://evil.test',
            headers: {'x-forwarded-host': 'app.example.com'}
        })).toBe(403);
    });

    it('accepts the ORIGIN environment variable', async () => {
        vi.stubEnv('ORIGIN', 'https://public.example.com');
        try {
            WebSockets.continuous('/origin-env', {useConnectionKeys: false});
            expect(await handshake('/origin-env', {origin: 'https://public.example.com'})).toBe(101);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('accepts only listed origins, compared after normalizing', async () => {
        WebSockets.continuous('/origin-list', {
            useConnectionKeys: false,
            allowedOrigins: ['HTTPS://Trusted.example.com:443/']
        });

        expect(await handshake('/origin-list', {origin: 'https://trusted.example.com'})).toBe(101);
        expect(await handshake('/origin-list', {origin: self()})).toBe(403);
        expect(await handshake('/origin-list', {origin: 'https://evil.test'})).toBe(403);
    });

    it("allows any origin with '*'", async () => {
        WebSockets.continuous('/origin-any', {useConnectionKeys: false, allowedOrigins: '*'});

        expect(await handshake('/origin-any', {origin: 'https://evil.test'})).toBe(101);
    });

    it('lets a function decide, and treats a throw as a rejection', async () => {
        WebSockets.continuous('/origin-fn', {
            useConnectionKeys: false,
            allowedOrigins: async (origin) => origin.endsWith('.trusted.test')
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            WebSockets.continuous('/origin-throws', {
                useConnectionKeys: false,
                allowedOrigins: () => {
                    throw new Error('boom');
                }
            });

            expect(await handshake('/origin-fn', {origin: 'https://a.trusted.test'})).toBe(101);
            expect(await handshake('/origin-fn', {origin: 'https://evil.test'})).toBe(403);
            expect(await handshake('/origin-throws', {origin: 'https://a.trusted.test'})).toBe(403);
            expect(consoleError).toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('rejects before beforeUpgrade runs', async () => {
        const beforeUpgrade = vi.fn(({accept}: { accept: () => unknown }) => accept());
        WebSockets.continuous('/origin-before', {useConnectionKeys: false}).beforeUpgrade = beforeUpgrade;

        expect(await handshake('/origin-before', {origin: 'https://evil.test'})).toBe(403);
        expect(beforeUpgrade).not.toHaveBeenCalled();
    });

    it('applies to use() and releases the endpoint on rejection', async () => {
        const handler = vi.fn();
        const url = WebSockets.use('/origin-use', handler);

        expect(await handshake(url, {origin: 'https://evil.test'})).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        expect(() => WebSockets.continuous('/origin-use')).not.toThrow();
    });

    it('applies a use() config to that endpoint', async () => {
        const url = WebSockets.use('/origin-use-config', (socket) => socket.send('ok'), {
            allowedOrigins: ['https://trusted.example.com']
        });

        expect(await handshake(url, {origin: 'https://trusted.example.com'})).toBe(101);
    });
});
