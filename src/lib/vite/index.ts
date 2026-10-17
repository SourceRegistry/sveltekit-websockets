import {WebSockets} from "../server/index.js";
import type {IncomingMessage} from "node:http";
import {resolve, join, dirname} from 'node:path';
import {styleText} from 'node:util';
import type {Duplex} from "node:stream";

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

export const websockets = (opts = {packageOutputDir: 'build'}) => {
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

    return {
        name: 'sveltekit-websocket-server',
        configurePreviewServer: (server: {httpServer?: {on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void} | null}) => {
            server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => WebSockets.upgrade(req, socket, head));
        },
        configureServer: (server: {httpServer?: {on(event: 'upgrade', listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void} | null}) => {
            server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => WebSockets.upgrade(req, socket, head));
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
