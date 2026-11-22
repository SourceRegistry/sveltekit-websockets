import {WebSockets} from "../server/index.js";
import type {IncomingMessage} from "node:http";
import {resolve, join, dirname} from 'node:path';
import {styleText} from 'node:util';
import type {Duplex} from "node:stream";
import type {Socket} from "node:net";
import {STATUS_CODES} from "node:http";

import {readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync} from 'node:fs';

// Get the package name from package.json
const getPackageJSON = () => {
    try {
        return JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf-8'));
    } catch (err) {
        try{
            return JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf-8'));
        }catch (err){
            console.error('Failed to read package.json:', err);
            return {name: '@app/server', version: '0.0.0'};
        }
    }
};

const _package = getPackageJSON();

const template = () =>
    `/**
 * AUTOMATICALLY GENERATED FILE DON'T EDIT MANUALLY
 * @date ${new Date().toISOString()}
 * @package ${_package.name}:${_package?.version}
 * @generated
 */

import * as adapter from "./_index.js";

import { WebSockets } from '${_package.name}/server';

// @sveltejs/adapter-node >= 6 exports the node:http Server as \`server\`;
// earlier versions export the polka app, which holds the http Server as \`server.server\`.
const httpServer = typeof adapter.server?.on === 'function' ? adapter.server : adapter.server?.server;
if (typeof httpServer?.on !== 'function') {
    throw new Error('${_package.name}: no HTTP server exported by the adapter entry (./_index.js)');
}
httpServer.on('upgrade', (req, socket, head) => WebSockets.upgrade(req, socket, head));

// adapter-node shuts down by calling httpServer.close() (SIGINT, SIGTERM, socket-activation idle) and only
// emits 'sveltekit:shutdown' once close() completes. close() waits for every connection, upgraded WebSockets
// included, so close those as soon as shutdown starts instead of hanging until SHUTDOWN_TIMEOUT.
if (typeof httpServer.close === 'function' && typeof WebSockets.shutdown === 'function') {
    const close = httpServer.close;
    httpServer.close = function (...args) {
        WebSockets.shutdown().catch((error) => console.error('${_package.name}: WebSocket shutdown failed', error));
        return close.apply(this, args);
    };
}

console.log('> SvelteKit WebSockets adapter');

export * from "./_index.js";
export default adapter;
`;

// Ensure the parent directory exists before writing a file
const ensureDirExists = (filePath: string) => {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        try {
            mkdirSync(dir, {recursive: true});
        } catch (err) {
            throw err; // Re-throw to make the error visible in the build process
        }
    }
};

export type WebSocketsPluginOptions = {
    /** adapter-node's output directory, whose `index.js` is wrapped at build time. Default `'build'`. */
    packageOutputDir?: string;
    /**
     * Dev and preview only: how long (ms) an upgrade request for a path without a registered route may wait
     * for another listener (Vite's HMR or proxy, Vitest, other plugins) to answer before it gets a
     * `404`. Without this such a request would hang forever. Default `5000`; `false` turns it off.
     */
    unhandledUpgradeTimeout?: number | false;
};

/** Answers an upgrade request nobody took with a 404, so the client doesn't wait forever. */
const notFound = (socket: Duplex) => {
    const body = 'No WebSocket endpoint at this path';
    socket.end(
        `HTTP/1.1 404 ${STATUS_CODES[404]}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body
    );
    socket.once('finish', () => socket.destroy());
};

export const websockets = (options: WebSocketsPluginOptions = {}) => {
    const opts = {packageOutputDir: 'build', unhandledUpgradeTimeout: 5000 as number | false, ...options};

    // Wraps the adapter-node entry (renamed to _index.js) with one that attaches the upgrade handler.
    const writeEntry = () => {
        try {
            // Use the absolute path and ensure no leading slash in join
            const outputDir = resolve(process.cwd(), opts.packageOutputDir);
            const filePath = join(outputDir, 'index.js');

            console.log(styleText(['cyan', 'bold'], `> Using ${_package.name}`));

            // Ensure the filepath directory exists
            ensureDirExists(filePath);

            if (existsSync(filePath)) {
                const indexContents = readFileSync(filePath, 'utf-8');
                if (!indexContents.includes('SvelteKit WebSockets adapter')) {
                    const oldIndexPath = join(outputDir, '_index.js');
                    rmSync(oldIndexPath, {force: true});
                    console.log(styleText(['yellow', 'italic'], `  - Renaming existing ${opts.packageOutputDir}/index.js -> ${opts.packageOutputDir}/_index.js`));
                    renameSync(filePath, oldIndexPath);
                }
            }

            // Write the template to app.js file
            writeFileSync(filePath, template(), {encoding: 'utf8'});
            console.log(styleText('green', '  ✔ done'));
        } catch (err) {
            console.log(styleText(['redBright'], 'Failed to write websocket adapter file:'), err);
            throw err; // Re-throw to make the error visible in the build process
        }
    };

    // The dev and preview servers have other 'upgrade' listeners (Vite's HMR and proxy, Vitest's browser
    // runner), so only take the requests for registered routes and leave the rest to them. Vite ignores
    // upgrades it doesn't own without answering, so one that nobody has answered after
    // `unhandledUpgradeTimeout` gets a 404 instead of hanging.
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (WebSockets.handles(req)) {
            WebSockets.upgrade(req, socket, head);
            return;
        }
        const timeout = opts.unhandledUpgradeTimeout;
        if (typeof timeout !== 'number' || !(timeout > 0)) return;
        // A reset while nobody owns the socket would otherwise be an unhandled 'error'.
        const ignore = () => {};
        socket.on('error', ignore);
        const timer = setTimeout(() => {
            // Another listener answered (bytes went out) or closed the socket.
            if (socket.destroyed || ((socket as Socket).bytesWritten ?? 0) > 0) return;
            notFound(socket);
        }, timeout);
        timer.unref?.();
        socket.once('close', () => {
            clearTimeout(timer);
            socket.off('error', ignore);
        });
    };

    return {
        name: 'sveltekit-websocket-server',
        configurePreviewServer: (server: {httpServer?: {on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void} | null}) => {
            server.httpServer?.on('upgrade', onUpgrade);
        },
        configureServer: (server: {httpServer?: {on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void} | null}) => {
            server.httpServer?.on('upgrade', onUpgrade);
        },
        // SvelteKit 2 runs the adapter while closing the bundle.
        closeBundle: {
            sequential: true,
            order: 'post', // Ensures this runs last in the writeBundle sequence
            handler: writeEntry
        },
        // SvelteKit 3 runs the adapter (which empties the output directory) in its own
        // `buildApp` hook with order 'post'. Post hooks run in plugin order, so this one
        // runs after it as long as websockets() comes after sveltekit() in `plugins`.
        buildApp: {
            order: 'post',
            handler: async () => writeEntry()
        }
    } satisfies import('vite').Plugin;
};
