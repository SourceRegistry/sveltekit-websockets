import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {Duplex} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {WebSocket as WsClient, WebSocketServer} from 'ws';
import {WebSockets} from '../server/index.js';
import {websockets, type WebSocketsPluginOptions} from './index.js';

type DevServer = { httpServer: Server };
type Hooks = { configureServer: (server: DevServer) => void, configurePreviewServer: (server: DevServer) => void };

let servers: Server[] = [];
let sockets: Duplex[] = [];

afterEach(async () => {
    await WebSockets.shutdown(100);
    // Upgrade sockets aren't tracked by the HTTP server, so close() would wait on ones left pending.
    sockets.forEach((socket) => socket.destroy());
    sockets = [];
    await Promise.all(servers.map((server) => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
    })));
    servers = [];
});

// A dev server with the plugin's upgrade hook plus a stand-in for Vite's HMR listener, which answers
// `/hmr` after `hmrDelay` ms and ignores everything else without a word, like Vite does.
const devServer = async (options: WebSocketsPluginOptions, hook: keyof Hooks = 'configureServer', hmrDelay = 0) => {
    const httpServer = createServer();
    servers.push(httpServer);
    const hmr = new WebSocketServer({noServer: true});
    httpServer.on('upgrade', (_req, socket) => sockets.push(socket));
    httpServer.on('upgrade', (req, socket, head) => {
        if (req.url !== '/hmr') return;
        setTimeout(() => hmr.handleUpgrade(req, socket, head, (ws) => ws.send('hmr')), hmrDelay);
    });
    (websockets(options) as unknown as Hooks)[hook]({httpServer});
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    return (httpServer.address() as AddressInfo).port;
};

// Resolves with 101 on a successful handshake, the HTTP status of a rejection, or 'pending' when nothing
// answered within `wait` ms.
const handshake = (port: number, path: string, wait = 1000) => new Promise<number | 'pending'>((resolve) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}${path}`);
    ws.on('error', () => {});
    const timer = setTimeout(() => {
        resolve('pending');
        ws.terminate();
    }, wait);
    ws.on('open', () => {
        clearTimeout(timer);
        resolve(101);
        ws.close();
    });
    ws.on('unexpected-response', (req, res) => {
        clearTimeout(timer);
        resolve(res.statusCode ?? 0);
        req.destroy();
    });
});

describe('vite plugin upgrade hook', () => {
    it('serves registered routes', async () => {
        const port = await devServer({unhandledUpgradeTimeout: 50});
        WebSockets.continuous('/chat', {useConnectionKeys: false});

        expect(await handshake(port, '/chat')).toBe(101);
    });

    it('answers an upgrade nobody takes with 404 after the timeout', async () => {
        const port = await devServer({unhandledUpgradeTimeout: 50});

        const started = Date.now();
        expect(await handshake(port, '/nowhere')).toBe(404);
        expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });

    it('leaves upgrades that another listener answers alone, even slowly', async () => {
        const port = await devServer({unhandledUpgradeTimeout: 100}, 'configureServer', 30);

        expect(await handshake(port, '/hmr')).toBe(101);
    });

    it('does the same on the preview server', async () => {
        const port = await devServer({unhandledUpgradeTimeout: 50}, 'configurePreviewServer');

        expect(await handshake(port, '/nowhere')).toBe(404);
        expect(await handshake(port, '/hmr')).toBe(101);
    });

    it('can leave unanswered upgrades pending with `false`', async () => {
        const port = await devServer({unhandledUpgradeTimeout: false});

        expect(await handshake(port, '/nowhere', 150)).toBe('pending');
    });

    it('survives a client resetting an unanswered upgrade', async () => {
        const port = await devServer({unhandledUpgradeTimeout: 50});

        const ws = new WsClient(`ws://127.0.0.1:${port}/nowhere`);
        ws.on('error', () => {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        ws.terminate();
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(await handshake(port, '/nowhere')).toBe(404);
    });
});
