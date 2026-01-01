# @sourceregistry/sveltekit-websockets

[![npm version](https://img.shields.io/npm/v/@sourceregistry/sveltekit-websockets?logo=npm)](https://www.npmjs.com/package/@sourceregistry/sveltekit-websockets)
[![License](https://img.shields.io/npm/l/@sourceregistry/sveltekit-websockets)](https://github.com/SourceRegistry/sveltekit-websockets/blob/main/LICENSE)
[![CI](https://github.com/SourceRegistry/sveltekit-websockets/actions/workflows/test.yml/badge.svg)](https://github.com/SourceRegistry/node-env/actions)

Typed WebSocket infrastructure for **SvelteKit**, providing both **ephemeral per-request sockets** and **persistent
WebSocket endpoints**, with a reactive Svelte client component and a Vite plugin for proper upgrade handling.

> ⚠️ **Node-only**
>
> This package **requires `@sveltejs/adapter-node`**.
> WebSockets are not supported on serverless or edge adapters.

---

## ✨ Features

* 🔌 **Per-request WebSockets** tied to SvelteKit actions
* 🔁 **Persistent WebSocket routes** via controller-based routing
* 🧠 Clear lifecycle hooks: `connect`, `message`, `close`, `error`
* 🧩 Svelte component for reactive streaming with auto-reconnect
* ⚙️ Vite plugin to enable `.upgrade()` in dev & preview
* 🔐 Ephemeral connection keys with TTL and cleanup
* 🧪 Designed for production-grade backends, not demos

---

## 📦 Installation

```sh
npm install @sourceregistry/sveltekit-websockets
```

or

```sh
pnpm add @sourceregistry/sveltekit-websockets
# or
yarn add @sourceregistry/sveltekit-websockets
```

---

## 📁 Project Structure

```
src/
├── lib/
│   ├── client/        # Svelte WebSocket component + helpers
│   ├── server/        # WebSocket controllers & server logic
│   └── vite/          # Vite plugin for upgrade handling
└── routes/
    └── ...            # SvelteKit routes using WebSockets
```

---

## 🧠 Server Usage

### 1️⃣ Per-request WebSockets (`use()`)

Creates a **single-use WebSocket URL** bound to a SvelteKit request (e.g. a form action).

```ts
// src/routes/example/+page.server.ts
import {websockets} from '$lib/server';

export const actions = {
    ws: async (event) => {
        return {
            url: websockets.use(event, (socket) => {
                socket.send("Connected!");

                socket.addEventListener("message", (msg) => {
                    console.log("Client says:", msg.data);
                });
            })
        };
    }
};
```

Returned response:

```json
{
  "url": "ws://localhost:5173/_/connect/abc123"
}
```

Characteristics:

* One-time connection key
* Automatically expires (TTL)
* Ideal for request-bound workflows and auth-safe upgrades

---

### 2️⃣ Persistent WebSockets (`continuous()`)

Register long-lived WebSocket endpoints independent of requests.

```ts
// src/lib/server/index.ts
import {WebSocketEndpointController} from '$lib/server/controller';

export const websockets = new WebSocketEndpointController();

websockets.continuous('/chat', (socket) => {
    socket.send("Welcome to /chat");

    socket.addEventListener("message", (msg) => {
        socket.send(`Echo: ${msg.data}`);
    });
});
```

Accessible via:

```
ws://localhost:5173/chat
```

---

## 🧑‍💻 Svelte Client Component

The package exports a Svelte component for declarative WebSocket usage.

```svelte
<script lang="ts">
    import WebSocket from "@sourceregistry/sveltekit-websockets";
</script>

<WebSocket action="?/ws">
    {#snippet message(data)}
        <p>{new Date().toLocaleTimeString()}: {data}</p>
    {/snippet}
</WebSocket>
```

### Component Props

| Prop         | Type      | Description                             |
|--------------|-----------|-----------------------------------------|
| `action`     | `string`  | POST action returning `{ url }`         |
| `url`        | `string`  | Direct WebSocket URL (optional)         |
| `data`       | `T[]`     | Reactive array of received messages     |
| `auto_open`  | `boolean` | Auto-connect on mount (default: `true`) |
| `controller` | object    | Manual `open()` / `close()` control     |
| `message`    | snippet   | Render callback per message             |

---

## ⚙️ Vite Plugin (Required)

To allow WebSocket upgrades during **development and preview**, the Vite plugin must be registered.

```ts
// vite.config.ts
import {defineConfig} from 'vite';
import {websockets} from '@sourceregistry/sveltekit-websockets/vite';

export default defineConfig({
    plugins: [
        sveltekit(),
        websockets() //ADD THIS
    ],
    server: {
        hmr: {
            port: 5174
        }
    }
});
```

Without this plugin:

* `.upgrade()` requests will fail in dev
* WebSockets may only work in production builds

---

## 🛠️ Internals Overview

The `WebSocketEndpointController` handles:

* WebSocket upgrade routing (`/_/connect/:key`)
* Ephemeral connection keys
* Active socket registry (`Map`)
* TTL-based cleanup
* Lifecycle hooks
* Optional guards (auth, IP, session)

This design keeps WebSocket logic **explicit, testable, and framework-aligned**.

---

## 🔐 Security Model

* One-time connection keys for `use()`
* Configurable TTL (default: 2 minutes)
* Automatic cleanup of closed sockets
* No global socket leaks
* Explicit routing and ownership

---

## 🤝 Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Open a Pull Request

---

## 📄 License

Apache-2.0
