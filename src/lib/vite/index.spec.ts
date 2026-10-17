import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {websockets} from './index.js';

type WebSocketsPlugin = ReturnType<typeof websockets>;

describe('websockets vite plugin', () => {
    it('replaces stale adapter entrypoint backups on repeated builds', () => {
        const cwd = process.cwd();
        const root = mkdtempSync(join(tmpdir(), 'sveltekit-websockets-'));
        const buildDir = join(root, 'build');
        mkdirSync(buildDir);

        try {
            process.chdir(root);

            const firstAdapterIndex = 'export const version = "first";\n';
            writeFileSync(join(buildDir, 'index.js'), firstAdapterIndex);

            const plugin = websockets({packageOutputDir: 'build'}) as WebSocketsPlugin;
            plugin.closeBundle.handler();

            expect(readFileSync(join(buildDir, '_index.js'), 'utf-8')).toBe(firstAdapterIndex);

            const secondAdapterIndex = 'export const version = "second";\n';
            writeFileSync(join(buildDir, 'index.js'), secondAdapterIndex);

            plugin.closeBundle.handler();

            expect(readFileSync(join(buildDir, '_index.js'), 'utf-8')).toBe(secondAdapterIndex);
            expect(readFileSync(join(buildDir, 'index.js'), 'utf-8')).toContain('SvelteKit WebSockets adapter');
        } finally {
            process.chdir(cwd);
            rmSync(root, {recursive: true, force: true});
        }
    });

    // Runs the generated build/index.js against a stub adapter entry and a stub
    // `<package>/server`, then checks the upgrade listener landed on the http server.
    const runGeneratedEntry = async (adapterEntry: string) => {
        const cwd = process.cwd();
        const root = mkdtempSync(join(tmpdir(), 'sveltekit-websockets-'));
        const buildDir = join(root, 'build');
        const name = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')).name as string;
        const stubPackage = join(root, 'node_modules', ...name.split('/'));
        mkdirSync(buildDir);
        mkdirSync(stubPackage, {recursive: true});
        writeFileSync(join(stubPackage, 'package.json'), JSON.stringify({
            name, type: 'module', exports: {'./server': './server.js'}
        }));
        writeFileSync(join(stubPackage, 'server.js'), 'export const WebSockets = { upgrade() {} };\n');
        writeFileSync(join(buildDir, 'index.js'), adapterEntry);

        try {
            process.chdir(root);
            (websockets({packageOutputDir: 'build'}) as WebSocketsPlugin).closeBundle.handler();
            process.chdir(cwd);
            return await import(pathToFileURL(join(buildDir, 'index.js')).href);
        } finally {
            process.chdir(cwd);
            rmSync(root, {recursive: true, force: true});
        }
    };

    const stubServer = `import { EventEmitter } from 'node:events';
const httpServer = new EventEmitter();`;

    it('attaches to the http server exported by adapter-node >= 6', async () => {
        const entry = await runGeneratedEntry(`${stubServer}
export { httpServer as server };
export const port = 3000;
`);
        expect(entry.server.listenerCount('upgrade')).toBe(1);
        expect(entry.port).toBe(3000);
    });

    it('attaches to the polka app exported by adapter-node < 6', async () => {
        const entry = await runGeneratedEntry(`${stubServer}
export const server = { server: httpServer };
`);
        expect(entry.server.server.listenerCount('upgrade')).toBe(1);
    });

    it('fails loudly when the adapter entry exports no server', async () => {
        await expect(runGeneratedEntry('export const port = 3000;\n')).rejects.toThrow(/no HTTP server/);
    });
});
