# Contributing

## Setup

```sh
npm install
npm run dev
```

## Workflow

1. Fork the repository and create a feature branch.
2. Make your change. If it touches `src/lib/server` or `src/lib/vite`, add or update a `*.spec.ts`
   alongside the file (see the existing specs for the pattern).
3. Run the full check before opening a PR:

   ```sh
   npm test        # svelte-check + vitest
   npm run build   # svelte-package + publint
   ```

4. Open a Pull Request against `main`.

## Commit messages

Releases are automated with `semantic-release` based on
[Conventional Commits](https://www.conventionalcommits.org/). Prefix commits with `fix:`, `feat:`,
`chore:`, etc. — the type determines whether a release is cut and whether it's a patch or minor bump.

## Project layout

```
src/
├── lib/
│   ├── client/   # Svelte WebSocket component + Action/ActionSocket helpers
│   ├── server/   # WebSocketEndpointController, ReferencedWebSocket, routing
│   └── vite/     # Vite plugin: dev/preview upgrade hook + adapter-node patch
└── routes/       # Example SvelteKit route used by `npm run dev`
```

See [API.md](./API.md) for the full API surface.
