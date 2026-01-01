import {defineConfig} from 'vitest/config';
import {playwright} from '@vitest/browser-playwright';
import {sveltekit} from '@sveltejs/kit/vite';
import {websockets} from "./src/lib/vite/index.js"; //!IMPORTANT Use @sourceregistry/sveltekit-websockets

export default defineConfig({
    plugins: [sveltekit(), websockets()],
    server: {
        hmr: {
            port: 5174
        }
    },
    test: {
        expect: {requireAssertions: true},
        projects: [
            {
                extends: './vite.config.ts',
                test: {
                    name: 'client',

                    browser: {
                        enabled: true,
                        provider: playwright(),
                        instances: [{browser: 'chromium', headless: true}]
                    },

                    include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
                    exclude: ['src/lib/server/**']
                }
            },

            {
                extends: './vite.config.ts',

                test: {
                    name: 'server',
                    environment: 'node',
                    include: ['src/**/*.{test,spec}.{js,ts}'],
                    exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
                }
            }
        ]
    }
});
