# 🔌 @sourceregistry/sveltekit-websockets

[![npm version](https://img.shields.io/npm/v/@sourceregistry/sveltekit-websockets?logo=npm)](https://www.npmjs.com/package/@sourceregistry/sveltekit-websockets)
[![License](https://img.shields.io/npm/l/@sourceregistry/sveltekit-websockets)](https://github.com/SourceRegistry/sveltekit-websockets/blob/main/LICENSE)
[![CI](https://github.com/SourceRegistry/sveltekit-websockets/actions/workflows/test.yml/badge.svg)](https://github.com/SourceRegistry/node-env/actions)

Typed WebSocket infrastructure for SvelteKit — per-request or continuous connections, full back-end lifecycle, and a
reactive Svelte component.

> **IMPORTANT: Works only with @sveltejs/adapter-node**
> <br/>
> **Make sure to load the [Vite plugin](#-vite-plugin) ←←←←←←←**

---

## ✨ Features

- ✅ Simple `.use(event, handler)` for session-bound WebSockets
- ♾️ `.continuous(path, handler)` for persistent routes
- 🧠 Lifecycle events: `connect`, `message`, `disconnect`
- 🧩 Svelte component: streaming messages, `bind:data`, auto reconnect
- ⚙️ Vite plugin: supports `.upgrade()` in dev and preview
- 🔒 Optional timeouts, auth, and cleanup guards

---

## 📦 Installation

```bash
npm add @sourceregistry/svelte-websockets
````

---

## 🗂️ Project Structure

```text
src/
├── lib/
│   ├── client/      # WebSocketStream.svelte and helpers
│   ├── server/      # WebSocketEndpointController and API
│   └── vite/        # Vite plugin for dev/preview upgrade handling
└── routes/          # WebSocket endpoints via +page.server.ts (EXAMPLE)
```

---

## 🚀 Server Usage

### 🔹 `use()` — One-time URL for per-request socket

```ts
// src/routes/example/+page.server.ts
import {websockets} from '$lib/server';

export const actions = {
    ws: async (event) => {
        return {
            url: websockets.use(event, (socket) => {
                socket.send("Connected 👋");

                const interval = setInterval(() => socket.send("Ping!"), 1000);
                socket.addEventListener("close", () => clearInterval(interval));
            })
        }
    }
};
```

Returns:

```ts
{
    url: "ws://localhost:5173/_/connect/abc123"
}
```

---

### 🔹 `continuous()` — Persistent WebSocket route

```ts
// src/lib/server/index.ts
import {WebSocketEndpointController} from './controller';

export const websockets = new WebSocketEndpointController();

websockets.continuous('/chat', (socket) => {
    socket.send("Welcome to /chat!");
});
```

---

## 🧩 Svelte Client

### Import the WebSocketStream component

```svelte
<script lang="ts">
    import {WebSocket} from "@sourceregistry/sveltekit-websockets"; // <<-- This uses the client
</script>

<WebSocket action="?/ws">
    {#snippet message(data)}
        <p>{new Date().toLocaleString()}: {data}</p>
    {/snippet}
</WebSocket>
```

Props:

| Prop         | Type                  | Description                        |
|--------------|-----------------------|------------------------------------|
| `action`     | string                | POST route that returns `{ url }`  |
| `url`        | string                | Optional direct WebSocket URL      |
| `data`       | `T[]`                 | Reactive list of received messages |
| `auto_open`  | boolean               | Connect on mount (default: true)   |
| `message`    | `(msg) =>`            | Render single message              |
| `controller` | `{ open(), close() }` | Control socket manually            |

---

## ⚙️ Vite Plugin

To enable `.upgrade()` handling in dev/preview:

```ts
// vite.config.ts
import {websockets} from '$lib/vite';

export default defineConfig({
    plugins: [
        websockets() //ADD this to enable websocket for you sveltekit project
    ],
    // ---- DEVELOPMENT ONLY ----
    server: {
        hmr: {
            port: 5174 //TO NOT CONFLICY WITH VITE HOT MODULE RELOAD
        }
    },
    // --------
});
```

---

## 🧠 Internals

The `WebSocketEndpointController` manages:

* All connected sockets (`Map<string, WebSocket>`)
* Metadata for timeouts, sessions, IPs
* Upgrade routing for `/_/connect/:key`
* Lifecycle events: `connect`, `disconnect`, `error`
* Optional: per-socket auth, TTL, and queueing

---

## 🔒 Security

* Ephemeral one-time keys for `use()` connections
* Configurable TTL (default: 2 minutes)
* Optional user/session guard middleware
* Built-in cleanup of disconnected sockets

---

## Contributing

Contributions are very welcome!
Please open issues for bugs or feature requests and pull requests for changes.
Follow the standard fork → branch → PR workflow.

---

🙌 **Contributing**
PRs welcome! Please:

- Add tests for new features
- Maintain 100% coverage
- Follow existing code style

Found a security issue? [Report it responsibly](mailto:a.p.a.slaa@projectsource.nl).

🔗 **GitHub**: [github.com/SourceRegistry/sveltekit-websockets](https://github.com/SourceRegistry/sveltekit-websockets)  
📦 **npm**: [@sourceregistry/sveltekit-websockets](https://www.npmjs.com/package/@sourceregistry/sveltekit-websockets)
