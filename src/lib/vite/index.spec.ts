import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
});
