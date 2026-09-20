# @sourceregistry/sveltekit-websockets

[![npm version](https://img.shields.io/npm/v/@sourceregistry/sveltekit-websockets?logo=npm)](https://www.npmjs.com/package/@sourceregistry/sveltekit-websockets)
[![License](https://img.shields.io/npm/l/@sourceregistry/sveltekit-websockets)](https://github.com/SourceRegistry/sveltekit-websockets/blob/main/LICENSE)
[![CI](https://github.com/SourceRegistry/sveltekit-websockets/actions/workflows/ci.yml/badge.svg)](https://github.com/SourceRegistry/sveltekit-websockets/actions)

Typed WebSocket infrastructure for **SvelteKit** — per-request or continuous connections, full back-end lifecycle,
and a reactive Svelte component for the client.

> ⚠️ **Node-only.** This package requires `@sveltejs/adapter-node`. WebSockets are not supported on
> serverless or edge adapters.

---

## Features

- 🔌 Per-request WebSockets tied to SvelteKit form actions
- 🔁 Persistent WebSocket routes via controller-based routing
- 🧠 Lifecycle hooks: `connect`, `disconnect`, `error`, `destroy`
- 🧩 Reactive Svelte component with auto-connect and snippets for streamed messages
- ⚙️ Vite plugin that wires up `.upgrade()` handling in dev and preview
- 🔐 Ephemeral, single-use connection keys with TTL and automatic cleanup

---

## Installation

```sh
npm install @sourceregistry/sveltekit-websockets
```

---

## Quick start

### 1. Register the Vite plugin (required)

WebSocket upgrades need a hook into the dev/preview HTTP server. Add the plugin in `vite.config.ts`:

```ts
import {defineConfig} from 'vite';
import {sveltekit} from '@sveltejs/kit/vite';
import {websockets} from '@sourceregistry/sveltekit-websockets/vite';

export default defineConfig({
    plugins: [
        sveltekit(),
        websockets(), // ADD THIS
    ],
});
```

Without it, `.upgrade()` requests fail in dev and preview (production builds on `adapter-node` are patched
automatically at build time).

### 2. Per-request WebSockets (`use()`)

Bind a single-use WebSocket to a SvelteKit form action. The client gets back a one-time URL that expires
automatically.

```ts
// src/routes/chat/+page.server.ts
import {websockets} from '@sourceregistry/sveltekit-websockets/server';

export const actions = {
    ws: (event) => ({
        url: websockets.use(event, (socket) => {
            socket.send('Connected!');
            socket.addEventListener('message', (msg) => {
                console.log('Client says:', msg.data);
            });
        }),
    }),
};
```

### 3. Persistent WebSockets (`continuous()`)

Register a long-lived endpoint independent of any single request, typically from `src/hooks.server.ts`:

```ts
import {websockets} from '@sourceregistry/sveltekit-websockets/server';

const chat = websockets.continuous('/chat', {useConnectionKeys: false});

chat.on('connect', (socket) => {
    socket.send('Welcome to /chat');
    socket.addEventListener('message', (msg) => socket.send(`Echo: ${msg.data}`));
});
```

Now reachable at `ws://localhost:5173/chat`.

### 4. Svelte client component

```svelte
<script lang="ts">
    import WebSocket from '@sourceregistry/sveltekit-websockets';
</script>

<WebSocket action="?/ws">
    {#snippet message(data)}
        <p>{new Date().toLocaleTimeString()}: {data}</p>
    {/snippet}
</WebSocket>
```

| Prop         | Type      | Description                                    |
|--------------|-----------|-------------------------------------------------|
| `action`     | `string`  | Form action that returns `{ url }`              |
| `url`        | `string`  | Direct WebSocket URL, as an alternative to `action` |
| `data`       | `T[]`     | Bindable, reactive array of received messages   |
| `auto_open`  | `boolean` | Auto-connect on mount (default: `true`)         |
| `controller` | snippet   | Render callback for manual `open()` / `close()` |
| `message`    | snippet   | Render callback per received message            |

---

## Full API reference

For every configuration option, server event, low-level socket API (`broadcast`, `send`, `raw()`,
graceful shutdown, rate limiting, timeouts, etc.), and the client-side `Action`/`ActionSocket` helpers, see
**[API.md](./API.md)**.

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## License

Apache-2.0
