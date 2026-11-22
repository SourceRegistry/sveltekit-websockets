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

- `connectionHandler(socket, controller)` fires once, on the first (and only) connection. Clean up anything
  it starts (intervals, subscriptions) when the socket closes, e.g.
  `socket.addEventListener('close', () => clearInterval(timer))`; nothing stops them for you. A synchronous throw
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

An upgrade for a path with no registered route gets HTTP `404`. (The dev/preview plugin only passes
registered routes here; see [Vite plugin internals](#vite-plugin-internals) for the rest.)

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
| `authHandler`            | `(req) => boolean \| Promise<boolean>`           | allow all | Called before the handshake; returning `false` answers HTTP `401`. See [Connection checks](#connection-checks). |
| `allowedOrigins`         | `'same-origin' \| '*' \| string[] \| (origin, req) => boolean \| Promise<boolean>` | `'same-origin'` | Browser origins allowed to connect; others get HTTP `403` before the handshake. See [Origin check](#origin-check). |
| `limit`                  | `number`                                         | unlimited | Max simultaneous connections; further upgrades get HTTP `503`.                |
| `useConnectionKeys`      | `boolean`                                        | `true`    | Require a one-time `?key=` query param minted by `.new`.                     |
| `pendingKeyExpiration`   | `number` (ms)                                    | `120_000` | TTL for an unused connection key.                                            |
| `requiredParams`         | `string[]`                                       | `[]`      | Query params that must be present, otherwise HTTP `400`.                      |
| `timeout`                | `number` (ms)                                    | disabled  | Idle timeout; reset on client `message`/`ping` (not on heartbeat pongs). Closes with `1001` on expiry. |
| `heartbeat`              | `number` (ms) | `false`                         | `30_000`  | Ping interval; connections that don't answer by the next ping are terminated (`1006`). See [Heartbeat](#heartbeat). |
| `maxPayload`             | `number` (bytes)                                 | `1_048_576` | Largest message a client may send; bigger messages close the connection with `1009`. `0` removes the limit. |
| `rateLimit`              | `{max: number, window: number, key?: (req) => string | undefined}` | disabled  | Max connection attempts per client per window (ms). See [Rate limiting](#rate-limiting). |

### Heartbeat

A client that disappears without a close frame (dropped network, sleeping laptop, crashed browser) leaves a
half-open TCP connection the server can keep for a long time, still counted against `limit` and still in
every `broadcast`. Every `heartbeat` ms the server pings each connection; one that hasn't answered the
previous ping, or sent anything else, by then is terminated, which emits `disconnect` with code `1006`. A
dead peer is detected within one to two intervals.

Browsers answer pings automatically, so the client needs no code for this. Set `heartbeat: false` to turn it
off, for example when a proxy in front already does it.

Heartbeat pongs don't reset `timeout`: an idle client still times out even though it answers pings.

### Message size limit

`maxPayload` (default 1 MiB) caps the size of a single message from a client. A bigger message closes the
connection with `1009` (Message Too Big) and emits `error` on the controller (or logs it, when nothing
listens). `ws` allows up to 100 MiB per message by default, which lets one client make the server buffer
that much memory per connection. Raise the limit for endpoints that receive large uploads.

### Connection checks

Every check runs on the upgrade request, before the WebSocket handshake, and a failed check is answered
with a plain HTTP response. A rejected client never gets a socket, never reaches `beforeUpgrade` or the
`connect` event, and costs the server no WebSocket state. In order:

| Check                       | Response                                                   |
|-----------------------------|-------------------------------------------------------------|
| `rateLimit`                 | `429 Too Many Requests` with `Retry-After` (seconds)        |
| `allowedOrigins`            | `403 Forbidden` — `Origin not allowed`                      |
| `limit`                     | `503 Service Unavailable` — `Too many connections`          |
| connection key              | `403 Forbidden` — `Invalid or expired connection key`       |
| `requiredParams`            | `400 Bad Request` — `Missing required parameter: <name>`    |
| `authHandler`               | `401 Unauthorized` — `Authentication failed`                 |
| `authHandler` throws        | `500 Internal Server Error` (the error is reported)         |
| `beforeUpgrade` `decline()` | the status you pass (default `400`)                          |

The response body is the reason text. Non-browser clients (`ws`, curl) can read the status; browsers
can't, and report any refused handshake as an `error` event followed by close code `1006`. See
[Reconnect](#reconnect) for what that means for the `<WebSocket>` component.

`controller.authorize(req)` runs the same checks and resolves the rejection (or `undefined`), for custom
servers that want to reject before upgrading themselves. Sockets upgraded by your own code and passed to
`controller.add(ws, req)` without `authorize` are still checked, and closed with the matching
[`WebSocketError`](#websocketerror) code when rejected.

### Rate limiting

`rateLimit` counts connection attempts per client and answers the ones over `max` per `window` ms with
HTTP `429` and a `Retry-After` header (emitting `rateLimit`). Clients are told apart by IP address, resolved like adapter-node's
`getClientAddress()`:

- By default, the TCP peer address. Behind a reverse proxy that is the proxy, so every user would share one
  limit.
- Set the `ADDRESS_HEADER` environment variable (the same one adapter-node reads) to the header your proxy
  sets, e.g. `X-Forwarded-For` or `X-Real-IP`. With `X-Forwarded-For`, `XFF_DEPTH` (default `1`) is the
  number of trusted proxies: the address is taken that many entries from the right, so entries a client
  adds itself are ignored. If the header is missing or too short, the TCP peer is used.
- IPv6 addresses share one limit per /64, since a client usually controls the whole block.

Only set `ADDRESS_HEADER` when a proxy always sets that header; otherwise clients can pick their own address.
To identify clients differently (a user id, an API key), pass `rateLimit.key(req)`; returning `undefined`
exempts the request. The resolver is exported as `clientAddress(req, {addressHeader?, xffDepth?})`.

`rateLimit` has no effect on `use()`: every call gets its own controller with a single connection. Rate-limit
the form action that calls `use()` instead.

### Origin check

Browsers attach cookies to WebSocket handshakes from any site, so without an origin check a malicious page
could open a socket as the logged-in visitor (cross-site WebSocket hijacking). `allowedOrigins` decides
which `Origin` headers are accepted:

- `'same-origin'` (default): the `Origin` host must match the request's `Host` or `X-Forwarded-Host`, or the
  `Origin` must equal the `ORIGIN` environment variable (the one adapter-node uses). The scheme isn't
  compared, so a TLS-terminating proxy works as is.
- `'*'`: any origin.
- `string[]`: exact origins, e.g. `['https://app.example.com']` (normalized: case and default ports don't
  matter).
- `(origin, req) => boolean | Promise<boolean>`: your own rule. A throw counts as a rejection.

Requests without an `Origin` header are always allowed: browsers send one on every WebSocket handshake, so
only non-browser clients omit it, and those don't carry a visitor's cookies. `Origin: null` (sandboxed
iframes, `file://`) only passes with `'*'` or a function.

The check runs before `beforeUpgrade`, after the rate limit. `raw()` endpoints aren't checked.

```ts
websockets.continuous('/chat', {allowedOrigins: ['https://app.example.com', 'https://admin.example.com']});
```

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
- `authorize(req): Promise<UpgradeRejection | undefined>` — runs the [connection checks](#connection-checks)
  on an upgrade request. Consumes a valid connection key and counts against the rate limit.
- `add(ws, req): Promise<boolean>` — registers an upgraded socket; checks it first unless `authorize`
  already passed for `req`.
- `beforeUpgrade?: UpgradeHandler` — runs after the connection checks pass, before a socket is created; call
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
- `lastActivity?: number` — updated on client `message`/`ping` when `timeout` is configured.

All the usual `ws` instance methods (`send`, `close`, `ping`, `pong`, `terminate`, `on`, event-listener
methods, etc.) are available as normal.

---

## `WebSocketError`

Close codes for sockets rejected after the handshake (sockets passed to `add()` without `authorize()`)
and for idle timeouts. A plain `as const` object (not an enum), since several names share a code;
`WebSocketError` is also the type of its values.

| Name                   | Code   |
|------------------------|--------|
| `TOO_MANY_CONNECTIONS` | `1013` |
| `INVALID_KEY`          | `1008` |
| `MISSING_PARAM`        | `1008` |
| `AUTH_FAILED`          | `1008` |
| `ORIGIN_NOT_ALLOWED`   | `1008` |
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
| `messages` | `(data: T[], ws: WebSocket)`                             | Once, with the received messages (the latest `max_messages`). |
| `message`  | `(data: T, index: number, ws: WebSocket)`                | Once per message, in order.                |
| `controller` | `(ctrl: ActionSocketController)`                       | Always — gives manual control regardless of `auto_open`. |

Events: `onopen`, `onclose`, `onmessage` mirror the native `WebSocket` events; `onerror` instead receives an
`ActionSocketError`. `onreconnect(attempt, delay)` fires when a reconnect is scheduled.

`ActionSocketController` (passed to the `controller` snippet):

```ts
type ActionSocketController = {
    open(): Promise<void>;                        // also cancels a scheduled reconnect
    close(code?: number, reason?: string): void;  // also cancels pending connects and reconnects
    readonly websocket: WebSocket | undefined;
    readonly isOpen: boolean;
    readonly state: number | undefined; // WebSocket.readyState
    readonly reconnecting: boolean;     // a reconnect is scheduled
};
```

### Reconnect

Off by default. `reconnect` takes `true` (defaults) or options:

| Option            | Default     | Description                                                       |
|-------------------|-------------|--------------------------------------------------------------------|
| `retries`         | unlimited   | Maximum consecutive attempts; the count resets once a connection opens. |
| `delay`           | `1000`      | Base delay in ms.                                                  |
| `factor`          | `2`         | Backoff multiplier.                                                |
| `maxDelay`        | `30000`     | Upper bound for the delay in ms.                                   |
| `shouldReconnect` | see below   | `(ev: CloseEvent) => boolean`, decides per close.                  |

The wait before attempt `n` is `min(delay * factor^(n-1), maxDelay)`, randomized to between half and all of
that so many clients don't reconnect at the same moment after a server restart.

Reconnects happen after the connection drops and after a failed action request. By default a close with
code `1000`/`1005` (the server closed normally) or `1008` (policy violation) doesn't reconnect, since
retrying wouldn't help; `defaultShouldReconnect` is exported if
you want to extend that rule. `close()` and unmounting never reconnect.

Endpoints refuse failed [connection checks](#connection-checks) (auth, origin, rate limit) before the
handshake, and browsers report that as close code `1006`, the same as a network failure, so it is retried.
Set `retries` to bound that, or check authentication in the form action (with `use()`), which fails before
any socket is opened.

Action-based sockets re-run the action on every attempt, so each gets a fresh single-use connection key.
Received messages in `data` are kept across reconnects.

```svelte
<WebSocket action="?/ws" reconnect={{retries: 10, maxDelay: 10_000}} onreconnect={(n, ms) => console.log(`retry ${n} in ${ms}ms`)}/>
```

---

## Vite plugin internals

`websockets(options?)` takes:

| Option                    | Default   | Description                                                                 |
|---------------------------|-----------|------------------------------------------------------------------------------|
| `packageOutputDir`        | `'build'` | adapter-node's output directory, whose `index.js` is wrapped at build time.  |
| `unhandledUpgradeTimeout` | `5000`    | Dev/preview: ms an upgrade for an unregistered path may wait for another listener before it gets `404`. `false` turns it off. |

It does two things:

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
[`handles(req)`](#handlesreq)); anything else, such as Vite's HMR socket, a `server.proxy` WebSocket or
Vitest's browser runner, is left to its own listener. A separate `server.ws.port` is therefore not needed.

Vite ignores upgrades it doesn't own without answering them, so a request for a path nobody serves (a typo,
an endpoint not registered yet) would hang. If no listener has written anything back after
`unhandledUpgradeTimeout` ms, the plugin answers `404`. Raise it if a proxied WebSocket target takes longer
than that to accept, or set `false` to leave such requests alone.

---

## Security model

- Browser `Origin` headers are checked against `allowedOrigins` (default same-origin) before the
  handshake, which blocks cross-site WebSocket hijacking. See [Origin check](#origin-check).
- Connection keys (`use()`, and `continuous()` unless disabled) are single-use, random (256-bit,
  URL-safe), and expire after `pendingKeyExpiration` (default 2 minutes).
- Expired keys and stale rate-limit entries are swept every 30 seconds.
- Rate limits count per client IP, resolved through `ADDRESS_HEADER`/`XFF_DEPTH` behind a proxy and per
  /64 for IPv6, so a client can't get a fresh limit by changing its User-Agent or prepending
  `X-Forwarded-For` entries. See [Rate limiting](#rate-limiting).
- `rateLimit`, `allowedOrigins`, `limit`, connection keys, `requiredParams` and `authHandler` all run before
  the WebSocket handshake; a rejected client gets an HTTP error response and never a socket. See
  [Connection checks](#connection-checks).
- Sockets are removed from the registry the moment they close, and the heartbeat terminates peers that
  vanished without closing, so dead connections cannot accumulate. See [Heartbeat](#heartbeat).
- Client messages are capped at `maxPayload` (default 1 MiB) so one client can't make the server buffer
  arbitrarily large frames. See [Message size limit](#message-size-limit).
