# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A thin-client IDE for infrastructure you own. The UI runs either as a browser PWA or as a
Tauri 2 desktop app; both talk the same `{event, data}` JSON protocol to a control plane
(`~/src/compute-agent-server`, Go) which forwards to `compute-agent` processes on your
machines. Nothing in the UI touches a local filesystem — every file read, write, and shell
is a remote request against an agent addressed by `clientId`.

## Commands

```sh
npm install
VITE_SERVER_URL=http://localhost:8443 npm run dev   # browser build; proxies /ws, /api, /auth
npm run tauri:dev                                   # desktop build (Rust core + webview)
npm run build                                       # vue-tsc -b && vite build (+ PWA)
npm run typecheck                                   # vue-tsc -b only

npm test                                            # vitest run (all src/**/*.test.ts)
npx vitest run src/services/mime.test.ts            # one file
npx vitest run -t 'resolves relative'               # one test by name
npm run test:watch

cargo test                                          # workspace: src-tauri, rebase-core, rebase-cli
cargo build -p rebase-cli                           # the `rebase` CLI binary
```

Run the **full** suite (`npm test` and `cargo test`) before committing — not just the build.

Toolchain is pinned in `.tool-versions` (rust 1.94.1); crates set `rust-version = "1.77"`.

## Architecture

### Two transports, one contract

`src/transport/contract.ts` defines the `Transport` interface and `isTauri()`. Everything
above it is transport-agnostic:

- **Browser** — `socket.ts` (`ControlPlaneSocket`): plain WebSocket to `/ws/dashboard`,
  capped exponential-backoff reconnect, answers server `ping` with `pong`. **Not Socket.IO.**
- **Desktop** — `tauri.ts` (`TauriTransport`): the webview never opens a socket. `emit` goes
  to the Rust `emit` command; inbound frames arrive as `cp://frame` / `cp://status` Tauri
  events. Rust owns TLS (rustls + cert pinning), so it can reach a self-signed agent that a
  browser PWA cannot. See [docs/DIRECT-MODE.md](docs/DIRECT-MODE.md).

The same split exists for session/auth in `src/services/platform.ts` (`TauriPlatform` vs
`BrowserPlatform`) and persistence in `src/services/store.ts` (tauri-plugin-store vs
localStorage). When adding a capability that differs by host, extend one of these two
interfaces rather than sprinkling `isTauri()` checks.

### Protocol rules

[docs/PROTOCOL.md](docs/PROTOCOL.md) is the source of truth, extracted from the real Go
server/agent. Key invariants:

- There are **no acks**. Every request carries a client-generated `requestId` (or a
  server-generated `session` for PTYs) and responses come back as separate events.
- `src/transport/rpc.ts` is the only correlation primitive: `expect()` for multi-response /
  streamed flows (`file_put`, chunked reads), `call()`/`next()` for one-shot.
- 1 MB WebSocket frame limit on both legs; chunked file I/O uses 256 KB raw chunks
  (base64 via `transport/encoding.ts`).
- Wire types live in `src/transport/types.ts`. Protocol assumptions must not leak past
  `services/fileService.ts` and `services/ptyService.ts`.
- File read (`file_get_request` / `file_get_chunk` / `file_get_result`) mirrors `file_put` in
  reverse and is implemented on both sides, but only takes effect where the agent and control
  plane are actually deployed — against an older deployment, opening a file errors while
  browse/save/shell still work.
- There is no `stat` event: file metadata is derived by listing the parent directory.

### Rust workspace

- `rebase-core` — shared `config` (`~/.config/rebase/config.toml`), `oidc`, `tokens` (OS
  keychain via `keyring`), `connection`. Used by both the desktop app and the CLI.
- `src-tauri` — the desktop core. `lib.rs` registers every `#[tauri::command]` and handles
  the `rebase://callback?token=…` deep link (validated before storage). `transport.rs` owns
  the WS/TLS connection; `crucible.rs` handles index cache + chat streaming + exec-allowlist
  edits; `codesearch.rs` queries the LanceDB index.
- `rebase-cli` — `rebase auth|cp|keys` (clap).

Adding a Tauri command means touching three places: the `#[tauri::command]` fn, the
`generate_handler!` list in `lib.rs`, and the matching method on a `Platform`/service in TS.

### Plugin host

`src/services/plugins.ts` is an in-process host for trusted first-party modules. A plugin's
`activate(ctx)` registers contributions through registries — `commands`, `statusBar`,
`menus`, `views`, `viewers`, `keybindings` — and every registration is tracked in a
per-plugin disposer bag, so deactivate fully removes it. An `activate()` that throws is
rolled back in isolation and does not abort the other plugins.

Bundled plugins live in `src/plugins/` (terminal, notifications, projects, viewers,
crucible) and are listed in `src/plugins/index.ts`. To add one, copy `src/plugins/_template/`
and append it to `bundledPlugins`. Imperative actions a plugin can't own (opening a terminal
panel) come through `HostCapabilities` / `services/dock.ts`, which the Workbench registers
on mount.

Viewers are content-aware file renderers keyed by MIME (`services/mime.ts`), registered via
the viewers registry and routed in `components/panels/EditorPanel.vue`.

### Workspace layout

`Workbench.vue` frames a Dockview editor area with three columns:
`ServersColumn` (agents from the CP's `client_list`), `ProjectColumn` (file explorer with a
single ephemeral browse root, plus the project explorer where a PROJECT owns multi-root
`rootPaths[]`), and `ToolsColumn`. Context menu and confirm dialog are app-wide floating
singletons mounted in `App.vue`.

### Crucible (code intelligence)

Indexing runs on the **agent**, where the files are: the app uploads the pinned
`rebase-indexer` binary (SHA-256 verified against hashes baked into `services/crucible.ts`),
adds it to the control plane's exec allowlist, builds the index, downloads one archive, and
extracts it into a local cache that the Rust `search_code` command queries via LanceDB.
Embeddings and chat both go through Ollama. **`INDEXER_SHA256` must be updated whenever
`INDEXER_VERSION` changes** — it is the only thing preventing a compromised release from
executing on the agent.

### Session lifecycle

`stores/session.ts`: `loading → unauthenticated → disconnected → connecting → connected`.
"Connected" means attached to a control plane; the user then picks an agent, which sets
`activeClientId` — the target of every file/shell request.

## UI conventions

- Type scale is fixed at four `@theme` steps in `src/style.css`: `text-2xs` (badges/micro),
  `text-xs` (uppercase labels, metadata), `text-sm` (body + interactive, the workhorse),
  `text-base` (titles, primary actions). Do not introduce `text-[Npx]`.
- Colors come from `@theme` tokens (`bg-surface`, `text-muted`, `text-accent`, …). The
  `:root` CSS variables are legacy, kept only for scoped styles and the Dockview theme.
- Use the primitives in `src/components/ui/` — `Button`, `IconButton`, `Badge`,
  `SectionHeader`, `InlineInput` — instead of ad-hoc class stacks.
- Tailwind v4 via `@tailwindcss/vite`; there is no `tailwind.config.js`.

## Testing

Vitest with jsdom, `@` aliased to `src/`. Tests sit next to their subject
(`services/mime.test.ts`). Coverage is concentrated on pure helpers and store logic —
transport and Tauri IPC are not mocked end-to-end, so protocol changes need a real control
plane to verify.
