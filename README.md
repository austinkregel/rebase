# rebase

A thin-client IDE for infrastructure you own. Browser PWA or Tauri desktop app →
control plane (`compute-agent-server`) → `compute-agent` on your machines.

## Stack

Vue 3 · Pinia · CodeMirror 6 · xterm.js · Dockview · Tailwind 4 ·
vite-plugin-pwa · Tauri 2 (Rust core).
Transport is a **plain WebSocket** (`/ws/dashboard`, `{event, data}` JSON
frames) — not Socket.IO. See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the wire
contract extracted from the real server/agent code,
[docs/agent-protocol.md](docs/agent-protocol.md) for the agent side, and
[docs/DIRECT-MODE.md](docs/DIRECT-MODE.md) for the desktop app ↔ agent path.

## Layout

```
src/
  transport/   contract.ts (Transport interface), socket.ts (browser WS),
               tauri.ts (Rust-core transport), rpc.ts (requestId correlation),
               types.ts, encoding.ts — every protocol assumption lives here
  services/    fileService.ts, ptyService.ts, platform.ts (auth/session per
               host), plugins.ts + contribution registries, crucible*.ts
  stores/      session.ts, agents.ts, files.ts, projects.ts (Pinia)
  plugins/     bundled first-party plugins (terminal, notifications, projects,
               viewers, crucible) — copy _template/ to add one
  components/  Workbench + columns/, panels/, viewers/, ui/ primitives
  cm/          setup.ts (extensions, compartments), theme.ts

rebase-core/   shared config, OIDC, keychain tokens (Rust)
rebase-cli/    `rebase auth|cp|keys`
src-tauri/     desktop core: WS+TLS, deep links, crucible index, code search
```

## Develop

```sh
npm install
VITE_SERVER_URL=http://localhost:8443 npm run dev   # browser; proxies /ws, /api, /auth
npm run tauri:dev                                   # desktop app
npm run build                                       # vue-tsc + vite + PWA
npm test && cargo test                              # full suite
```

## Deployment note

File read (`file_get_request` / `file_get_chunk` / `file_get_result`) is
implemented in the UI, the agent, and the control plane — see the "File read"
section of [docs/PROTOCOL.md](docs/PROTOCOL.md). It only works once the agent
and control plane on the far end are actually running a build that includes it;
against an older deployment, opening a file shows a clear error while browse,
save, and shell keep working.
