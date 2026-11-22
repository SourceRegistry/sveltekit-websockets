import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {WebSocket as WsClient} from 'ws';
import {clientAddress, WebSocketError, WebSockets} from './index.js';
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
    const attempt = (path: string, headers: Record<string, string> = {}) => new Promise<'open' | number>((resolve) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}${path}`, {headers});
        ws.on('error', () => {});
        ws.on('close', (code) => resolve(code === WebSocketError.RATE_LIMITED ? code : 'open'));
        ws.on('open', () => setTimeout(() => ws.close(), 20));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('counts all attempts from one address against one limit, whatever the User-Agent', async () => {
        WebSockets.continuous('/rl-ua', {useConnectionKeys: false, rateLimit: {max: 2, window: 60_000}});

        const results = [];
        for (const agent of ['a', 'b', 'c']) results.push(await attempt('/rl-ua', {'user-agent': agent}));

        expect(results).toEqual(['open', 'open', WebSocketError.RATE_LIMITED]);
    });

    it('limits each client behind a proxy separately', async () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-forwarded-for');
        WebSockets.continuous('/rl-proxy', {useConnectionKeys: false, rateLimit: {max: 1, window: 60_000}});

        expect(await attempt('/rl-proxy', {'x-forwarded-for': '203.0.113.1'})).toBe('open');
        expect(await attempt('/rl-proxy', {'x-forwarded-for': '203.0.113.2'})).toBe('open');
        expect(await attempt('/rl-proxy', {'x-forwarded-for': '203.0.113.1'})).toBe(WebSocketError.RATE_LIMITED);
        // A spoofed entry prepended by the client doesn't give it a fresh limit.
        expect(await attempt('/rl-proxy', {'x-forwarded-for': '1.1.1.1, 203.0.113.1'})).toBe(WebSocketError.RATE_LIMITED);
    });

    it('shares one limit across an IPv6 /64', async () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-real-ip');
        WebSockets.continuous('/rl-ipv6', {useConnectionKeys: false, rateLimit: {max: 1, window: 60_000}});

        expect(await attempt('/rl-ipv6', {'x-real-ip': '2001:db8:0:1::1'})).toBe('open');
        expect(await attempt('/rl-ipv6', {'x-real-ip': '2001:db8:0:1:ffff::2'})).toBe(WebSocketError.RATE_LIMITED);
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
        expect(await attempt('/rl-key', {'x-user': 'alice'})).toBe(WebSocketError.RATE_LIMITED);
        expect(await attempt('/rl-key', {'x-user': 'admin'})).toBe('open');
        expect(await attempt('/rl-key', {'x-user': 'admin'})).toBe('open');
    });
});
