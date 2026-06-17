# rebase

A thin-client IDE for infrastructure you own. Browser PWA → control plane
(`compute-agent-server`) → `compute-agent` on your machines. 

## Stack

Vue 3 · Pinia · CodeMirror 6 · xterm.js · vite-plugin-pwa.
Transport is a **plain WebSocket** (`/ws/dashboard`, `{event, data}` JSON
frames) — not Socket.IO. See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the wire
contract extracted from the real server/agent code, and
[docs/agent-protocol.md](docs/agent-protocol.md) for the agent side.

## Layout

```
src/
  transport/   socket.ts (WS + reconnect), rpc.ts (requestId correlation),
               types.ts (wire types), encoding.ts (base64) — every protocol
               assumption lives here
  services/    fileService.ts (list/read/write/delete/chmod),
               ptyService.ts (shell sessions)
  stores/      session.ts, agents.ts, files.ts (Pinia)
  cm/          setup.ts (extensions, compartments), theme.ts
  components/  Workbench, Editor, FileTree, Terminal, AgentPicker,
               EditorTabs, StatusBar
```

## Develop

```sh
npm install
VITE_SERVER_URL=http://localhost:8443 npm run dev   # proxies /ws, /api, /auth
npm run build                                       # vue-tsc + vite + PWA
```

## Known protocol gap

The control plane currently has **no file read** event — see the
"PROTOCOL GAP" section of [docs/PROTOCOL.md](docs/PROTOCOL.md) for the proposed
`file_get_request` / `file_get_chunk` / `file_get_result` extension the UI
already implements. Until the server and agent support it, opening a file
shows a clear error; everything else (browse, save, shell) works against the
existing protocol.
