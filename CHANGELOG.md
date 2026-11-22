# [2.0.0](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.10...v2.0.0) (2026-11-22)


### Bug Fixes

* answer upgrades for unknown paths with 404 ([e1a6659](https://github.com/SourceRegistry/sveltekit-websockets/commit/e1a66593cd1ca40fef4ac097578bc27da95ce493))
* **client:** cap messages kept in <WebSocket> data ([9c02502](https://github.com/SourceRegistry/sveltekit-websockets/commit/9c0250250d7188a952ad4f08db46dad6fe47b61d))
* **client:** stop duplicate and orphaned sockets in <WebSocket> ([05f2c88](https://github.com/SourceRegistry/sveltekit-websockets/commit/05f2c88da51756109bafd9a0c1b61a4056041753))
* **demo:** clear the interval when the socket closes ([d0d8c39](https://github.com/SourceRegistry/sveltekit-websockets/commit/d0d8c39d3878cd44b358a05b4af0919d3217c44c))
* **server:** rate-limit by real client IP ([ea5725d](https://github.com/SourceRegistry/sveltekit-websockets/commit/ea5725d75f053949f57144c0ff332d1569e3abe1))


### Features

* **client:** reconnect <WebSocket> with exponential backoff ([d886e6f](https://github.com/SourceRegistry/sveltekit-websockets/commit/d886e6f44b9b53eae50afab4f6698eb731dd4f2f))
* send connection keys in Sec-WebSocket-Protocol, not the URL ([d93ba1b](https://github.com/SourceRegistry/sveltekit-websockets/commit/d93ba1b380fe95312e1938ab7bf29044c1cf65a3))
* **server:** add heartbeat and maxPayload limit ([fbe0586](https://github.com/SourceRegistry/sveltekit-websockets/commit/fbe0586d566f6b05b6d06d3f0f19c640828fdd38))
* **server:** isolate use() per call and close sockets on shutdown ([950378e](https://github.com/SourceRegistry/sveltekit-websockets/commit/950378ec18bb1ec0d2f38ddd244744de860a4afd))
* **server:** reject cross-origin WebSocket upgrades by default ([52811db](https://github.com/SourceRegistry/sveltekit-websockets/commit/52811dbae1820ce77a8a8d62d8f538afb102bdf7))
* **server:** run connection checks before the handshake ([d88c335](https://github.com/SourceRegistry/sveltekit-websockets/commit/d88c33525a5f801ae67707b1660c803d53fda06d))
* typed messages with a shared codec ([1b73d0d](https://github.com/SourceRegistry/sveltekit-websockets/commit/1b73d0d398c4629843d87c9b7eff1e5c8c8278af))


### BREAKING CHANGES

* the client and server must be upgraded together; an
older server can't read the key from the header. Keyed connections now
report `sveltekit-websockets` as their protocol unless the caller
passes its own.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
* **server:** rejected upgrades get an HTTP error instead of a close
frame (browsers report close code 1006, not 1008), and beforeUpgrade
now runs after the connection checks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
* **client:** `data` keeps only the latest 1000 messages by default;
set `max_messages={Infinity}` for the old behaviour.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
* **server:** clients from one address that only differed by
User-Agent now share a single rate limit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
* **server:** client messages over 1 MiB now close the connection
unless `maxPayload` is raised, and pongs no longer count as activity
for `timeout`.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
* **server:** browser clients on another origin are now refused
unless their origin is listed in `allowedOrigins`.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

## [1.0.10](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.9...v1.0.10) (2026-10-17)


### Bug Fixes

* **vite:** support adapter-node 6 and SvelteKit 3 production builds ([3cc05ff](https://github.com/SourceRegistry/sveltekit-websockets/commit/3cc05ff4df3ff227bf1d7adf8cbbe7c28a73db4f))

## [1.0.9](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.8...v1.0.9) (2026-09-20)


### Bug Fixes

* prevent raw-endpoint route leak and config mutation ([df624b3](https://github.com/SourceRegistry/sveltekit-websockets/commit/df624b36bf88c722c0bdeceb7089e833f907f80a))
* use server.ws.port instead of deprecated server.hmr.port ([65cb1b4](https://github.com/SourceRegistry/sveltekit-websockets/commit/65cb1b4704cf96940709229bab451e64fe2762ef))

## [1.0.8](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.7...v1.0.8) (2026-06-27)


### Bug Fixes

* update vite compatibility and audit issues ([7ebc022](https://github.com/SourceRegistry/sveltekit-websockets/commit/7ebc022783537f2b8bfc8a99b0b504f5102916ec))

## [1.0.7](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.6...v1.0.7) (2026-06-27)


### Bug Fixes

* **package:** updated dependencies ([24453fd](https://github.com/SourceRegistry/sveltekit-websockets/commit/24453fd5cc8fb54d6f0c712423d8685220e3b7a9))

## [1.0.6](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.5...v1.0.6) (2026-04-20)


### Bug Fixes

* **package:** remove SvelteKit peer audit path ([17c18d9](https://github.com/SourceRegistry/sveltekit-websockets/commit/17c18d951ba8c65b54693fa274da9c1ab2a9f31e))

## [1.0.5](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.4...v1.0.5) (2026-04-19)


### Bug Fixes

* expose referenced websocket type surface ([885096f](https://github.com/SourceRegistry/sveltekit-websockets/commit/885096f2a9b6d00246c6b9ee648f37cf43ff1ac3))

## [1.0.4](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.3...v1.0.4) (2026-04-18)


### Bug Fixes

* deserialize websocket action responses ([a47f8bc](https://github.com/SourceRegistry/sveltekit-websockets/commit/a47f8bcdb76435d07fcbd80b588ed47dc5037498))

## [1.0.3](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.2...v1.0.3) (2026-04-18)


### Bug Fixes

* expose referenced websocket methods ([b1421ac](https://github.com/SourceRegistry/sveltekit-websockets/commit/b1421accf89544e43e2014ee0f854bd8a71f02f6))

## [1.0.2](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.1...v1.0.2) (2026-04-18)


### Bug Fixes

* align exports and harden runtime ([296ed72](https://github.com/SourceRegistry/sveltekit-websockets/commit/296ed722c886996e82fccffe1bf139ac814c5312))
* npm token issues ([4caa327](https://github.com/SourceRegistry/sveltekit-websockets/commit/4caa327dd31ffb1e394b3dfbd30fc0c3c5a05509))

## [1.0.1](https://github.com/SourceRegistry/sveltekit-websockets/compare/v1.0.0...v1.0.1) (2026-01-01)


### Bug Fixes

* access public ([304cddf](https://github.com/SourceRegistry/sveltekit-websockets/commit/304cddf5dd03b56f70dbb85be3a7b437edafd546))

# 1.0.0 (2026-01-01)


### Bug Fixes

* added tsdoc comments ([541e4f7](https://github.com/SourceRegistry/sveltekit-websockets/commit/541e4f773f7a9f3cce53fcbe6dba4548e105a4e2))
