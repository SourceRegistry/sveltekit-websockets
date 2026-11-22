import {websockets} from '#lib/server/index.js'; // in your app: '@sourceregistry/sveltekit-websockets/server'
import type {Actions} from './$types.js';

export const actions = {
    ws: (event) => ({
        url: websockets.use(event, (socket) => {
            const timer = setInterval(() => socket.send('Hello World'), 1000);
            // Stop sending once the client is gone; the interval would otherwise run (and leak) forever.
            socket.addEventListener('close', () => clearInterval(timer));
        })
    })
} satisfies Actions;
