import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {WebSocket as WsClient, WebSocketServer} from 'ws';
import {clientAddress, ReferencedWebSocket, WebSocketError, WebSockets} from './index.js';
import type {IncomingMessage} from 'node:http';

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

        expect(await rejection(url)).toEqual({status: 403, body: 'Invalid or expired connection key'});

        first.ws.close();
        expect(keep).toContain('?key=');
    });

    it('drops an unused key after pendingKeyExpiration', async () => {
        const handler = vi.fn();
        const expired = WebSockets.use('/expiry', handler, {pendingKeyExpiration: 20});
        WebSockets.use('/expiry', () => {}); // keeps the route registered

        await sleep(60);

        expect((await rejection(expired)).status).toBe(403);
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

        expect(await rejection(url)).toEqual({status: 401, body: 'Authentication failed'});
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
            ORIGIN_NOT_ALLOWED: 1008,
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

describe('heartbeat', () => {
    const client = (path: string, options: { autoPong?: boolean } = {}) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, options);
        ws.on('error', () => {});
        let pings = 0;
        ws.on('ping', () => pings++);
        const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()));
        const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
        return {ws, opened, closed, pings: () => pings};
    };

    it('pings connections and keeps the ones that answer', async () => {
        const chat = WebSockets.continuous('/hb-alive', {useConnectionKeys: false, heartbeat: 20});
        const disconnect = vi.fn();
        chat.on('disconnect', disconnect);

        const c = client('/hb-alive');
        await c.opened;
        await sleep(150);

        expect(c.pings()).toBeGreaterThanOrEqual(3);
        expect(c.ws.readyState).toBe(WsClient.OPEN);
        expect(disconnect).not.toHaveBeenCalled();
        c.ws.close();
    });

    it('terminates a connection that stops answering', async () => {
        const chat = WebSockets.continuous('/hb-dead', {useConnectionKeys: false, heartbeat: 20});
        const disconnected = new Promise<number>((resolve) => chat.on('disconnect', (_ws, code) => resolve(code)));

        const c = client('/hb-dead', {autoPong: false});
        await c.opened;

        expect(await disconnected).toBe(1006);
        await c.closed;
        expect(c.pings()).toBeGreaterThanOrEqual(1);
    });

    it('counts any message as a sign of life', async () => {
        WebSockets.continuous('/hb-messages', {useConnectionKeys: false, heartbeat: 30});
        const c = client('/hb-messages', {autoPong: false});
        await c.opened;
        const chatter = setInterval(() => c.ws.send('still here'), 10);

        await sleep(150);
        clearInterval(chatter);

        expect(c.ws.readyState).toBe(WsClient.OPEN);
        c.ws.close();
    });

    it('can be disabled', async () => {
        WebSockets.continuous('/hb-off', {useConnectionKeys: false, heartbeat: false});
        const c = client('/hb-off', {autoPong: false});
        await c.opened;
        await sleep(80);

        expect(c.pings()).toBe(0);
        expect(c.ws.readyState).toBe(WsClient.OPEN);
        c.ws.close();
    });

    it('does not let heartbeat pongs reset the idle timeout', async () => {
        WebSockets.continuous('/hb-timeout', {useConnectionKeys: false, heartbeat: 20, timeout: 100});
        const c = client('/hb-timeout');
        await c.opened;

        expect(await c.closed).toBe(WebSocketError.TIMEOUT);
        expect(c.pings()).toBeGreaterThanOrEqual(1);
    });

    it('applies to use() connections', async () => {
        const url = WebSockets.use('/hb-use', () => {}, {heartbeat: 20});
        const c = client(url, {autoPong: false});
        await c.opened;

        expect(await c.closed).toBe(1006);
    });
});

describe('maxPayload', () => {
    const echo = (path: string, config: { maxPayload?: number }) => {
        const chat = WebSockets.continuous(path, {useConnectionKeys: false, ...config});
        chat.on('error', () => {});
        chat.on('connect', (socket) => socket.on('message', (data) => socket.send(data)));
    };

    const roundTrip = async (path: string, size: number) => {
        const {ws, opened, closed} = connect(path);
        await opened;
        const reply = new Promise<number>((resolve) => ws.once('message', (data: Buffer) => resolve(data.length)));
        ws.send(Buffer.alloc(size));
        const result = await Promise.race([reply.then((length) => ({length})), closed]);
        ws.close();
        return result;
    };

    it('closes with 1009 when a message is bigger than the limit', async () => {
        echo('/max-small', {maxPayload: 16});

        expect(await roundTrip('/max-small', 16)).toEqual({length: 16});
        expect(await roundTrip('/max-small', 17)).toMatchObject({code: 1009});
    });

    it('defaults to 1 MiB', async () => {
        echo('/max-default', {});

        expect(await roundTrip('/max-default', 1024 * 1024)).toEqual({length: 1024 * 1024});
        expect(await roundTrip('/max-default', 1024 * 1024 + 1)).toMatchObject({code: 1009});
    });

    it('removes the limit with 0', async () => {
        echo('/max-off', {maxPayload: 0});

        expect(await roundTrip('/max-off', 2 * 1024 * 1024)).toEqual({length: 2 * 1024 * 1024});
    });

    it('applies a use() config to that endpoint', async () => {
        const url = WebSockets.use('/max-use', (socket, controller) => {
            controller.on('error', () => {});
            socket.on('message', (data) => socket.send(data as Buffer));
        }, {maxPayload: 8});

        expect(await roundTrip(url, 9)).toMatchObject({code: 1009});
    });
});

describe('clientAddress()', () => {
    const request = (remoteAddress: string, headers: Record<string, string> = {}) =>
        ({socket: {remoteAddress}, headers}) as unknown as IncomingMessage;

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('uses the TCP peer and ignores forwarding headers unless configured', () => {
        expect(clientAddress(request('10.0.0.1', {'x-forwarded-for': '6.6.6.6'}))).toBe('10.0.0.1');
    });

    it('strips the IPv4-mapped IPv6 prefix', () => {
        expect(clientAddress(request('::ffff:192.0.2.7'))).toBe('192.0.2.7');
    });

    it('takes the address xffDepth entries from the right, ignoring what the client prepended', () => {
        const req = request('10.0.0.1', {'x-forwarded-for': '6.6.6.6, 203.0.113.5, 10.0.0.2'});

        expect(clientAddress(req, {addressHeader: 'x-forwarded-for'})).toBe('10.0.0.2');
        expect(clientAddress(req, {addressHeader: 'X-Forwarded-For', xffDepth: 2})).toBe('203.0.113.5');
    });

    it('falls back to the TCP peer when the header is missing or too short', () => {
        expect(clientAddress(request('10.0.0.1'), {addressHeader: 'x-forwarded-for'})).toBe('10.0.0.1');
        expect(clientAddress(request('10.0.0.1', {'x-forwarded-for': '203.0.113.5'}),
            {addressHeader: 'x-forwarded-for', xffDepth: 2})).toBe('10.0.0.1');
    });

    it('reads any other header as-is', () => {
        expect(clientAddress(request('10.0.0.1', {'x-real-ip': ' 203.0.113.9 '}), {addressHeader: 'x-real-ip'}))
            .toBe('203.0.113.9');
    });

    it('defaults to the ADDRESS_HEADER and XFF_DEPTH environment variables', () => {
        vi.stubEnv('ADDRESS_HEADER', 'X-Forwarded-For');
        vi.stubEnv('XFF_DEPTH', '2');

        expect(clientAddress(request('10.0.0.1', {'x-forwarded-for': '203.0.113.5, 10.0.0.2'}))).toBe('203.0.113.5');
    });
});

describe('rateLimit', () => {
    // Resolves 'open' when the handshake succeeds, otherwise the HTTP status of the rejection.
    const attempt = (path: string, headers: Record<string, string> = {}) => new Promise<'open' | number>((resolve) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, {headers});
        ws.on('error', () => {});
        ws.on('open', () => {
            resolve('open');
            ws.close();
        });
        ws.on('unexpected-response', (req, res) => {
            resolve(res.statusCode ?? 0);
            req.destroy();
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('counts all attempts from one address against one limit, whatever the User-Agent', async () => {
        WebSockets.continuous('/rl-ua', {useConnectionKeys: false, rateLimit: {max: 2, window: 60_000}});

        const results = [];
        for (const agent of ['a', 'b', 'c']) results.push(await attempt('/rl-ua', {'user-agent': agent}));

        expect(results).toEqual(['open', 'open', 429]);
    });

    it('limits each client behind a proxy separately', async () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-forwarded-for');
        WebSockets.continuous('/rl-proxy', {useConnectionKeys: false, rateLimit: {max: 1, window: 60_000}});

        expect(await attempt('/rl-proxy', {'x-forwarded-for': '203.0.113.1'})).toBe('open');
        expect(await attempt('/rl-proxy', {'x-forwarded-for': '203.0.113.2'})).toBe('open');
        expect(await attempt('/rl-proxy', {'x-forwarded-for': '203.0.113.1'})).toBe(429);
        // A spoofed entry prepended by the client doesn't give it a fresh limit.
        expect(await attempt('/rl-proxy', {'x-forwarded-for': '1.1.1.1, 203.0.113.1'})).toBe(429);
    });

    it('shares one limit across an IPv6 /64', async () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-real-ip');
        WebSockets.continuous('/rl-ipv6', {useConnectionKeys: false, rateLimit: {max: 1, window: 60_000}});

        expect(await attempt('/rl-ipv6', {'x-real-ip': '2001:db8:0:1::1'})).toBe('open');
        expect(await attempt('/rl-ipv6', {'x-real-ip': '2001:db8:0:1:ffff::2'})).toBe(429);
        expect(await attempt('/rl-ipv6', {'x-real-ip': '2001:db8:0:2::1'})).toBe('open');
    });

    it('uses a custom key, and exempts requests it returns undefined for', async () => {
        WebSockets.continuous('/rl-key', {
            useConnectionKeys: false,
            rateLimit: {
                max: 1,
                window: 60_000,
                key: (req) => req.headers['x-user'] === 'admin' ? undefined : String(req.headers['x-user'])
            }
        });

        expect(await attempt('/rl-key', {'x-user': 'alice'})).toBe('open');
        expect(await attempt('/rl-key', {'x-user': 'bob'})).toBe('open');
        expect(await attempt('/rl-key', {'x-user': 'alice'})).toBe(429);
        expect(await attempt('/rl-key', {'x-user': 'admin'})).toBe('open');
        expect(await attempt('/rl-key', {'x-user': 'admin'})).toBe('open');
    });
});

describe('checks before the handshake', () => {
    // Resolves with the handshake outcome: 101 on success, otherwise the HTTP rejection.
    const respond = (path: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number, headers: Record<string, unknown>, body: string, ws?: WsClient }>((resolve) => {
            const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, {headers});
            ws.on('error', () => {});
            ws.on('open', () => resolve({status: 101, headers: {}, body: '', ws}));
            ws.on('unexpected-response', (req, res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    resolve({status: res.statusCode ?? 0, headers: res.headers, body});
                    req.destroy();
                });
            });
        });

    it('answers a rate-limited attempt with 429 and Retry-After', async () => {
        WebSockets.continuous('/pre-rate', {useConnectionKeys: false, rateLimit: {max: 1, window: 10_000}});

        const first = await respond('/pre-rate');
        const second = await respond('/pre-rate');

        expect(first.status).toBe(101);
        expect(second).toMatchObject({status: 429, body: 'Rate limit exceeded'});
        expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(9);
        expect(Number(second.headers['retry-after'])).toBeLessThanOrEqual(10);
        first.ws?.close();
    });

    it('answers a full endpoint with 503', async () => {
        WebSockets.continuous('/pre-full', {useConnectionKeys: false, limit: 1});

        const first = await respond('/pre-full');
        expect(first.status).toBe(101);
        expect(await respond('/pre-full')).toMatchObject({status: 503, body: 'Too many connections'});
        first.ws?.close();
    });

    it('answers a missing or wrong connection key with 403', async () => {
        const chat = WebSockets.continuous('/pre-key');

        expect((await respond('/pre-key')).status).toBe(403);
        expect((await respond('/pre-key?key=nope')).status).toBe(403);
        const ok = await respond(chat.new);
        expect(ok.status).toBe(101);
        ok.ws?.close();
    });

    it('answers a missing required parameter with 400', async () => {
        WebSockets.continuous('/pre-param', {useConnectionKeys: false, requiredParams: ['room']});

        expect(await respond('/pre-param')).toMatchObject({status: 400, body: 'Missing required parameter: room'});
        const ok = await respond('/pre-param?room=1');
        expect(ok.status).toBe(101);
        ok.ws?.close();
    });

    it('answers a failed authHandler with 401 without ever upgrading', async () => {
        const chat = WebSockets.continuous('/pre-auth', {
            useConnectionKeys: false,
            authHandler: async (req) => req.headers.authorization === 'Bearer ok'
        });
        const onConnect = vi.fn();
        const beforeUpgrade = vi.fn(({accept}) => accept());
        chat.on('connect', onConnect);
        chat.beforeUpgrade = beforeUpgrade;

        expect(await respond('/pre-auth')).toMatchObject({status: 401, body: 'Authentication failed'});
        expect(onConnect).not.toHaveBeenCalled();
        expect(beforeUpgrade).not.toHaveBeenCalled();

        const ok = await respond('/pre-auth', {authorization: 'Bearer ok'});
        expect(ok.status).toBe(101);
        expect(beforeUpgrade).toHaveBeenCalledTimes(1);
        ok.ws?.close();
    });

    it('answers a throwing authHandler with 500 and reports the error', async () => {
        const chat = WebSockets.continuous('/pre-throw', {
            useConnectionKeys: false,
            authHandler: () => {
                throw new Error('session store down');
            }
        });
        const errors: Error[] = [];
        chat.on('error', (error) => errors.push(error));

        expect((await respond('/pre-throw')).status).toBe(500);
        expect(errors.map((error) => error.message)).toEqual(['session store down']);
    });

    it('counts a request that passed the checks only once', async () => {
        const chat = WebSockets.continuous('/pre-once', {useConnectionKeys: false, rateLimit: {max: 1, window: 60_000}});
        chat.on('connect', (socket) => socket.send('welcome'));

        const client = connect('/pre-once');
        expect(await client.firstMessage).toBe('welcome');
        client.ws.close();
    });

    it('releases a use() endpoint when the client leaves during an async authHandler', async () => {
        const handler = vi.fn();
        const url = WebSockets.use('/pre-gone', handler, {
            authHandler: async () => {
                await sleep(50);
                return true;
            }
        });

        const ws = new WsClient(`ws://127.0.0.1:${port}${url}`);
        ws.on('error', () => {});
        await sleep(10);
        ws.terminate();
        await sleep(100);

        expect(handler).not.toHaveBeenCalled();
        expect(() => WebSockets.continuous('/pre-gone')).not.toThrow();
    });

    it('still checks sockets handed to add() directly, closing rejected ones', async () => {
        const chat = WebSockets.continuous('/direct', {
            useConnectionKeys: false,
            authHandler: (req) => req.headers.authorization === 'Bearer ok'
        });
        chat.on('connect', (socket) => socket.send('welcome'));

        const wss = new WebSocketServer({noServer: true, WebSocket: ReferencedWebSocket});
        const custom = createServer();
        custom.on('upgrade', (req, socket, head) =>
            wss.handleUpgrade(req, socket, head, (ws) => chat.add(ws as ReferencedWebSocket, req)));
        await new Promise<void>((resolve) => custom.listen(0, '127.0.0.1', resolve));
        const customPort = (custom.address() as AddressInfo).port;

        const open = (headers: Record<string, string>) => {
            const ws = new WsClient(`ws://127.0.0.1:${customPort}/direct`, {headers});
            ws.on('error', () => {});
            return new Promise<number | string>((resolve) => {
                ws.once('message', (data) => {
                    resolve(data.toString());
                    ws.close();
                });
                ws.once('close', (code) => resolve(code));
            });
        };

        try {
            expect(await open({})).toBe(WebSocketError.AUTH_FAILED);
            expect(await open({authorization: 'Bearer ok'})).toBe('welcome');
        } finally {
            await new Promise((resolve) => custom.close(resolve));
        }
    });
});

describe('unregistered paths', () => {
    it('answers with 404', async () => {
        expect(await rejection('/not-registered')).toEqual({status: 404, body: 'No WebSocket endpoint at this path'});
    });
});
