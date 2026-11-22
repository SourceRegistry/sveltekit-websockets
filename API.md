# API Reference

Developer reference for `@sourceregistry/sveltekit-websockets`. For installation and a quick start, see
[README.md](./README.md).

## Contents

- [Server: `websockets`](#server-websockets)
  - [`continuous(route, config?)`](#continuousroute-config)
  - [`use(route, connectionHandler, config?)`](#useroute-connectionhandler-config)
  - [`raw(route, handle)`](#rawroute-handle)
  - [`upgrade(req, socket, head)`](#upgradereq-socket-head)
  - [`handles(req)`](#handlesreq)
  - [`shutdown(timeout?)`](#shutdowntimeout)
  - [`clear()`](#clear)
- [`WebSocketEndpointConfig`](#websocketendpointconfig)
- [`WebSocketEndpointController`](#websocketendpointcontroller)
- [`ReferencedWebSocket`](#referencedwebsocket)
- [`WebSocketError`](#websocketerror)
- [`WebSocketRawEndpointController`](#websocketrawendpointcontroller)
- [Client: `Action` / `ActionSocket`](#client-action--actionsocket)
- [Client: `<WebSocket>` component](#client-websocket-component)
- [Vite plugin internals](#vite-plugin-internals)
- [Security model](#security-model)

---

## Server: `websockets`

Imported from `@sourceregistry/sveltekit-websockets/server`. A process-wide singleton (stored on
`globalThis`) that owns every registered route.

### `continuous(route, config?)`

Registers (or returns the existing) long-lived endpoint at `route` and returns its
[`WebSocketEndpointController`](#websocketendpointcontroller).

```ts
const chat = websockets.continuous('/chat', {timeout: 60_000});
```

- `route` — a pathname string, a `URL`, or anything with a `url: URL` (e.g. a SvelteKit `RequestEvent`).
- `config` — [`WebSocketEndpointConfig`](#websocketendpointconfig), minus `disposer`/`path`.
- Calling this again for the same path returns the **existing** controller; the `config` argument is
  ignored on subsequent calls.
- Throws if the path is already registered by `use()` or `raw()`.

### `use(route, connectionHandler, config?)`

Creates a **single-use** endpoint bound to one connection and returns the connection URL, including a
one-time key. Every call gets its own controller and handler, so concurrent calls for the same route (e.g.
many users hitting the same form action) are isolated: each key reaches the handler of the call that minted
it. The endpoint is released when its connection closes, when its handshake is rejected, or when its key
expires unused (`pendingKeyExpiration`).

```ts
export const actions = {
    ws: (event) => ({
        url: websockets.use(event, (socket, controller) => {
            socket.send('hi');
        }, {timeout: 30_000}),
    }),
};
```

- `connectionHandler(socket, controller)` fires once, on the first (and only) connection. A synchronous throw
  closes the socket with `1011`; a rejected promise is reported as an `error` event on the controller (or
  logged if nobody listens).
- `config` — same as `continuous`, minus `disposer`/`limit`/`path` (`limit` is forced to `1`).
  `useConnectionKeys: false` is ignored: the key is what routes the connection to this call's handler.
- Throws if the path is already registered by `continuous()` or `raw()`.

### `raw(route, handle)`

Escape hatch for taking over the raw HTTP upgrade yourself — no `ReferencedWebSocket`, no connection
registry, no keys, timeouts, or rate limiting. Use this if you want to hand the socket to a different
WebSocket implementation.

```ts
websockets.raw('/legacy', async (req, socket, head) => {
    // handle the upgrade manually
});
```

### `upgrade(req, socket, head)`

The HTTP `'upgrade'` event handler. Wired up for you by the [Vite plugin](#vite-plugin-internals) in dev
and by the production adapter patch; call it yourself only if you're integrating with a custom server.

An upgrade for a path with no registered route gets its socket ended.

### `handles(req)`

`true` when a route is registered for the upgrade request's path. Use it on a server that has other
`'upgrade'` listeners, so requests this library doesn't own are left to them:

```ts
httpServer.on('upgrade', (req, socket, head) => {
    if (websockets.handles(req)) websockets.upgrade(req, socket, head);
});
```

The Vite plugin does this in dev and preview.

### `shutdown(timeout?)`

Unregisters every route and closes every connection with code `1001`, force-terminating sockets still open
after `timeout` ms (default `5000`). Resolves once all controllers are destroyed.

Node's `httpServer.close()` waits for upgraded WebSocket connections too, so a server shutdown hangs until
they close. The generated `adapter-node` entry calls `shutdown()` as soon as `httpServer.close()` is called
(which adapter-node does on SIGINT/SIGTERM). With a custom server, call it yourself:

```ts
process.on('SIGTERM', async () => {
    await websockets.shutdown();
    httpServer.close();
});
```

### `clear()`

Same as `shutdown()` with the default timeout. Returns its promise.

---

## `WebSocketEndpointConfig`

| Option                  | Type                                             | Default   | Description                                                                 |
|--------------------------|--------------------------------------------------|-----------|-------------------------------------------------------------------------------|
| `authHandler`            | `(req) => boolean \| Promise<boolean>`           | allow all | Called before a connection is accepted; returning `false` closes it (`1008`). |
| `limit`                  | `number`                                         | unlimited | Max simultaneous connections; excess connections are closed (`1013`).        |
| `useConnectionKeys`      | `boolean`                                        | `true`    | Require a one-time `?key=` query param minted by `.new`.                     |
| `pendingKeyExpiration`   | `number` (ms)                                    | `120_000` | TTL for an unused connection key.                                            |
| `requiredParams`         | `string[]`                                       | `[]`      | Query params that must be present or the connection is closed (`1008`).      |
| `timeout`                | `number` (ms)                                    | disabled  | Idle timeout; reset on `message`/`ping`/`pong`. Closes with `1001` on expiry. |
| `rateLimit`              | `{max: number, window: number}`                  | disabled  | Max connection attempts per client (IP + User-Agent) per rolling window.      |

---

## `WebSocketEndpointController`

Returned by `continuous()`/`use()`. Extends `EventEmitter` and implements `GenericWebSocketEndpointController`.

### Events

| Event        | Payload                                     | When                                    |
|--------------|----------------------------------------------|------------------------------------------|
| `connect`    | `(socket: ReferencedWebSocket)`               | A connection is accepted.                |
| `disconnect` | `(socket, code: number, reason: string)`      | A connection closes.                     |
| `error`      | `(error: Error, socket?: ReferencedWebSocket)`| A handler or socket throws.               |
| `rateLimit`  | `(req: IncomingMessage)`                      | A connection attempt is rate-limited.     |
| `destroy`    | —                                              | The controller is destroyed.              |

### Properties & methods

- `path: string` — the registered route pathname.
- `config: WebSocketEndpointConfig` — the effective (merged-with-defaults) config.
- `beforeUpgrade?: UpgradeHandler` — set this to intercept the raw upgrade before a socket is created; call
  `accept()` or `decline(reason, code?)`. Defaults to auto-accept. `decline` answers with an HTTP response:
  `code` is the HTTP status (`400`–`599`, default `400`; anything else is sent as `400`) and `reason` is the
  response body.
- `new: string` — a fresh URL for this route, including a newly minted connection key when
  `useConnectionKeys` is enabled. Each read mints a new key.
- `broadcast(data, options?, cb?)` — send to every open socket. `options.filter` selects a subset.
- `send(ref, data, options?, cb?)` — send to one socket by its `ref`; returns `false` if not found/open.
- `getConnectionsInfo()` — snapshot of all active connections plus pending-key/rate-limit counts.
- `resetTimeout(ref)` — manually reset a socket's idle timeout.
- `terminate(ref?)` — force-close one socket (or, with no argument, every socket on this route).
- `gracefulShutdown(timeout?)` — close code `1001` to every socket, force-terminating stragglers after
  `timeout` ms (default `5000`).
- `destroy()` — stop the cleanup timer, terminate all sockets, run the configured `disposer`, and emit
  `destroy`.
- `toJSON()` — a small summary object, useful for logging/metrics.

---

## `ReferencedWebSocket`

The `ws.WebSocket` subclass used for every managed connection (`instanceof WebSocket` still holds).

- `ref: string` — unique id, stable for the life of the connection; used with `send(ref, ...)`.
- `connectedAt: number` / `uptime: number` — connection timestamps.
- `params?: Record<string, string>` — the upgrade request's query parameters.
- `metadata: Record<string, any>` — free-form bag for your own per-connection state.
- `lastActivity?: number` — updated on `message`/`ping`/`pong` when `timeout` is configured.

All the usual `ws` instance methods (`send`, `close`, `ping`, `pong`, `terminate`, `on`, event-listener
methods, etc.) are available as normal.

---

## `WebSocketError`

Close codes used internally. A plain `as const` object (not an enum), since several names share a code;
`WebSocketError` is also the type of its values.

| Name                   | Code   |
|------------------------|--------|
| `TOO_MANY_CONNECTIONS` | `1013` |
| `INVALID_KEY`          | `1008` |
| `MISSING_PARAM`        | `1008` |
| `AUTH_FAILED`          | `1008` |
| `TIMEOUT`              | `1001` |
| `RATE_LIMITED`         | `1013` |

---

## `WebSocketRawEndpointController`

Backs `raw()`. Exposes only `path`, `config`, and `destroy()` — no connection registry, since that's your
handler's responsibility. `destroy()` removes the route from the internal registry.

---

## Client: `Action` / `ActionSocket`

Imported from `@sourceregistry/sveltekit-websockets` (or `.../client`). Lower-level helpers behind the
`<WebSocket action="...">` component — use them directly if you need the connection URL without opening a
socket yet, or want to open one outside of Svelte.

```ts
import {Action, ActionSocket} from '@sourceregistry/sveltekit-websockets/client';

// Just resolve the URL/protocols (e.g. to open the socket later, or hand it to another client):
const {url, protocols, open} = await Action('?/ws');

// Or open immediately:
const socket = await ActionSocket('?/ws');
```

- `Action(action, requestInit?, devalue = true)` — `POST`s the form action and resolves `{url, protocols,
  open()}`. When `devalue` is `true` (default), the action result is parsed with
  [`devalue`](https://github.com/sveltejs/devalue), matching SvelteKit's own action-result encoding; pass
  `false` if your action returns plain JSON `{url, protocols}` instead.
- `ActionSocket(action, requestInit?, devalue?)` — shorthand for `Action(...).then(r => r.open())`.
- `ActionSocketError` — an `Event` subclass wrapping the underlying failure (thrown fetch error, non-success
  action result, or the socket's own `error` event), passed to `onerror`.

---

## Client: `<WebSocket>` component

Full snippet surface, in addition to the props documented in the [README](./README.md#4-svelte-client-component):

| Snippet    | Signature                                             | Renders                                   |
|------------|--------------------------------------------------------|--------------------------------------------|
| `children` | `(ws: WebSocket)`                                       | Once the socket is open.                   |
| `messages` | `(data: T[], ws: WebSocket)`                             | Once, with the full accumulated message list. |
| `message`  | `(data: T, index: number, ws: WebSocket)`                | Once per message, in order.                |
| `controller` | `(ctrl: ActionSocketController)`                       | Always — gives manual control regardless of `auto_open`. |

Events: `onopen`, `onclose`, `onmessage` mirror the native `WebSocket` events; `onerror` instead receives an
`ActionSocketError`.

`ActionSocketController` (passed to the `controller` snippet):

```ts
type ActionSocketController = {
    open(): Promise<void>;
    close(code?: number, reason?: string): void;
    readonly websocket: WebSocket | undefined;
    readonly isOpen: boolean;
    readonly state: number | undefined; // WebSocket.readyState
};
```

---

## Vite plugin internals

`websockets({packageOutputDir: 'build'})` does two things:

1. **Dev & preview** — hooks the underlying HTTP server's `'upgrade'` event to
   `websockets.upgrade` for registered routes only, so `.upgrade()` requests work under `vite dev` /
   `vite preview` while other upgrades (Vite's HMR) are left alone.
2. **Production build (`closeBundle`, after `adapter-node` writes its output)** — patches the built
   `index.js` in `packageOutputDir` (default `build/`) so the standalone Node server also handles upgrades:
   the original adapter entrypoint is renamed to `_index.js`, and a small wrapper `index.js` is generated
   that imports it, attaches the upgrade handler to its `server`, calls [`shutdown()`](#shutdowntimeout) as
   soon as that server starts closing, and re-exports it. This step is idempotent
   — re-running the build regenerates the wrapper without re-renaming an already-wrapped entrypoint.

This currently assumes `@sveltejs/adapter-node`'s build output exports a `server` (a `polka` instance whose
`.server` is the underlying `http.Server`). Other Node adapters are not supported.

### Sharing the dev server's port with HMR

`configureServer`/`configurePreviewServer` attach the upgrade hook to the **same** `httpServer` that Vite's
dev/preview server uses. The hook only passes requests for registered routes to `WebSockets.upgrade` (see
[`handles(req)`](#handlesreq)); anything else, such as Vite's HMR socket or Vitest's browser runner, is left
to its own listener. A separate `server.ws.port` is therefore not needed.

---

## Security model

- Connection keys (`use()`, and `continuous()` unless disabled) are single-use, random (256-bit,
  URL-safe), and expire after `pendingKeyExpiration` (default 2 minutes).
- Expired keys and stale rate-limit entries are swept every 30 seconds.
- `authHandler`, `requiredParams`, and `rateLimit` are all enforced before a socket is added to a
  controller's registry — a rejected connection is closed and never tracked.
- Sockets are removed from the registry the moment they close, so idle/dead connections cannot accumulate.
