import {WebSockets} from "../server/index.js";
import type {IncomingMessage} from "node:http";
import {resolve, join, dirname} from 'node:path';
import {styleText} from 'node:util';
import type {Duplex} from "node:stream";

import {readFileSync, writeFileSync, mkdirSync, existsSync, renameSync} from 'node:fs';

// Get the package name from package.json
const getPackageJSON = () => {
    try {
        return JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf-8'));
    } catch (err) {
        try{
            return JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf-8'));
        }catch (err){
            console.error('Failed to read package.json:', err);
            // Default to a reasonable value if we can't read the package
            return '@app/server';
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

import * as polka from "./_index.js";

import { WebSockets } from '${_package.name}/server';
polka.server.server.on('upgrade', (req, socket, head) => WebSockets.instance.upgrade(req, socket, head));

console.log('> SvelteKit WebSockets adapter');

export default polka;
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
    return {
        name: 'sveltekit-websocket-server',
        configurePreviewServer(server) {
            server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => WebSockets.upgrade(req, socket, head));
        },
        configureServer(server) {
            server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => WebSockets.upgrade(req, socket, head));
        },
        closeBundle: {
            sequential: true,
            order: 'post', // Ensures this runs last in the writeBundle sequence
            handler: () => {
                try {
                    // Use the absolute path and ensure no leading slash in join
                    const outputDir = resolve(process.cwd(), opts.packageOutputDir);
                    const filePath = join(outputDir, 'index.js');

                    console.log(styleText(['cyan', 'bold'], `> Using ${_package.name}`));

                    // Ensure the filepath directory exists
                    ensureDirExists(filePath);

                    if (existsSync(filePath)) {
                        const oldIndexPath = join(outputDir, '_index.js');
                        console.log(styleText(['yellow', 'italic'], `  - Renaming exising ${opts.packageOutputDir}/index.js -> ${opts.packageOutputDir}/_index.js`));
                        renameSync(filePath, oldIndexPath);
                    }

                    // Write the template to app.js file
                    writeFileSync(filePath, template(), {encoding: 'utf8'});
                    console.log(styleText('green', '  ✔ done'));
                } catch (err) {
                    console.log(styleText(['redBright'], 'Failed to write websocket adapter file:'), err);
                    throw err; // Re-throw to make the error visible in the build process
                }
            }
        }
    } as import('vite').Plugin
};
