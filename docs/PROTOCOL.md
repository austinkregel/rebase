# UI ↔ Control Plane Protocol (source of truth)

Extracted from real code on 2026-06-10:

- Server: `~/src/compute-agent-server` (Go, chi router, `nhooyr.io/websocket`)
- Agent: `~/src/compute-agent` (`internal/app/agent.go`, `pkg/transport/transport.go`)
- Reference client: `~/src/backup-server-access-main/client/src/lib/sharedWS.js`

**This is NOT Socket.IO.** Both legs are plain WebSocket with a JSON envelope:

```json
{ "event": "<name>", "data": { ... } }
```

The full agent↔server contract is documented in [agent-protocol.md](agent-protocol.md).
This file covers only what the UI needs.

## Connection

- UI endpoint: `GET /ws/dashboard` (WebSocket upgrade), same host as the HTTP API.
  Build URL as `(location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + host + '/ws/dashboard'`.
- Default server port: `8443` (`server-example.json`).
- Auth: OIDC session cookie (browser) or `Authorization: Bearer <token>`.
  When `oidc.enabled` is false, no auth is required.
  - `GET /api/auth/status` (public) → `{ "authenticated": bool, "user": {...}|null }`
  - Login: redirect browser to `/auth/login`; callback sets the `session` cookie (24h TTL).
- On connect the server immediately sends `client_list`.
- Keepalive: server sends `ping` `{ "ts": <unix-ms> }`; reply with `pong` `{ "ts": <unix-ms> }`.
- Message size limit: 1 MB per WebSocket frame (both server and agent enforce this —
  keep chunks well under it).

## Addressing agents

Every request targeting a machine carries `clientId`. Request/response correlation
uses a client-generated `requestId` (UUID) echoed back in the response, or a
server-generated `session` (UUID) for shells. There are **no acks** — all
responses are separate events.

`client_list` (server → UI, on connect and on any agent connect/disconnect):

```json
{
  "clientIds": [
    { "clientId": "...", "lastPong": 1718000000000, "authenticated": true,
      "platform": "linux", "release": "...", "hostname": "...", "arch": "x86_64",
      "cpus": "8", "agentVersion": "v0.0.38" }
  ],
  "timestamp": "RFC3339"
}
```

`stats` (broadcast): `{ "clientId": "...", "data": { ...telemetry... } }`
`alerts` (broadcast): `{ "clientId": "...", "data": { "alerts": [...], "totalCount": n, "hasCritical": bool } }`

## Directory listing

UI → `dir_list_request`:

```json
{ "clientId": "...", "requestId": "<uuid>", "mode": "local", "path": "/abs/path" }
```

(`mode` also supports `"remote"` with `host`/`user`/`port`/`protocol` — not used by the IDE.)

Server → UI `dir_list_dispatched` `{ clientId, requestId, path, mode }`, then
`dir_list_response`:

```json
{
  "clientId": "...", "requestId": "...", "mode": "local", "path": "/abs/path",
  "entries": [
    { "name": "src", "type": "dir" },
    { "name": "main.go", "type": "file", "size": 1024, "mode": "-rw-r--r--",
      "modTime": "RFC3339", "isSymlink": false, "linkTarget": "" }
  ],
  "error": ""
}
```

`size`/`mode`/`modTime`/`isSymlink`/`linkTarget` are omitted when zero-valued.
`type` is `"dir"` or `"file"`. Agent times out the listing after 15s.

## File write (chunked upload)

The agent emits `file_put_result` **multiple times per upload**: once after
`file_put_start` (accept/reject, `ok` + `path`, no `size`), once on any failed
chunk (upload is cancelled), and once after `file_put_finish` (final, includes
`size`). The client must wait for the start-ack before streaming chunks, and must
treat any `ok:false` result as terminal.

1. UI → `file_put_start`
   `{ "clientId", "requestId", "path", "size": <bytes>, "mode": "0644"?, "force": false, "overwrite": true }`
2. Wait for `file_put_result` with `ok:true` (start accepted).
3. UI → `file_put_chunk` `{ "clientId", "requestId", "offset": <bytes>, "data": "<base64>" }`
   (`data` is Go `[]byte` → base64 string in JSON. Keep raw chunks ≤ 256 KiB.)
4. UI → `file_put_finish` `{ "clientId", "requestId", "checksum": "..."? }` (checksum optional)
5. Final `file_put_result`: `{ "clientId", "requestId", "ok": bool, "path", "size", "error"? }`

Server also emits `file_put_dispatched` `{ clientId, requestId, path }` after step 1.

## File delete / chmod / mkdir / rename

- `file_delete_request` `{ "clientId", "requestId", "path", "force"?: bool, "recursive"?: bool }`
  → `file_delete_result` `{ "clientId", "requestId", "path", "ok", "error"? }`
- `file_chmod_request` `{ "clientId", "requestId", "path", "mode": "755" }`
  → `file_chmod_result` `{ "clientId", "requestId", "ok", "path", "mode", "error"? }`
- `file_mkdir_request` `{ "clientId", "requestId", "path", "force"?: bool }`
  → `file_mkdir_result` `{ "clientId", "requestId", "ok", "path", "error"? }`
  (creates parents; `force` allows "dangerous" prefixes)
- `file_rename_request` `{ "clientId", "requestId", "path", "newPath", "force"?: bool }`
  → `file_rename_result` `{ "clientId", "requestId", "ok", "path", "error"? }`
  (rename or move; `force` overwrites an existing destination. Server emits a
  `file_*_dispatched` ack after each request, like `file_put`.)

## Exec (generic command)

- `exec_request` `{ "clientId", "requestId", "command", "cwd"?, "timeoutSec"? }`
  → `exec_result` `{ "clientId", "requestId", "ok", "code", "stdout", "stderr", "error"? }`
  Runs a command on the agent and returns its output. The agent enforces a
  **command allowlist** (blocked → `code:126`) and confines `cwd` to its allowed
  roots; shell metacharacters (pipes, `;`, `$()`, …) are rejected — use the PTY
  for an interactive shell. Relayed like `dir_list` (server emits `exec_dispatched`,
  then broadcasts `exec_result` correlated by `requestId`). Higher-level features
  are client-side helpers over this — e.g. git status runs
  `git status --porcelain --branch` and parses the output.

- `exec_allowlist` `{ "commands": [...] }` — **control plane → agent** (signed).
  The CP holds the canonical allowlist (`execAllowedCommands` in its config) and
  pushes it on agent connect and on change (`PUT /api/server/exec-allowlist`),
  so command policy is managed centrally, not per-agent. An empty list = allow all.

## Shell (PTY)

- UI → `shell_start` `{ "clientId": "..." }`
- Server → UI `shell_started` `{ "session": "<uuid>", "clientId": "..." }`
- UI → `shell_input` `{ "session", "data": "<raw utf-8 string>" }`
- UI → `shell_resize` `{ "session", "cols": n, "rows": n }`
- UI → `shell_close` `{ "session" }`
- Server → UI `shell_output` `{ "clientId", "session", "data": "<raw utf-8 string>" }`
  (raw passthrough, NOT base64 — agent does `string(bytes)`)
- Server → UI `shell_closed` `{ "clientId", "session", "reason": "exit 0" | ... }`
- Server → UI `shell_error` `{ "message": "clientId required" | "Client offline" | "Invalid session" }`

Shell output is routed only to the dashboard connection that started the session.

## File read (chunked download)

Mirrors `file_put` in reverse (implemented 2026-06-11; needs the agent +
control plane deployed to take effect):

- UI → server → agent: `file_get_request` `{ "clientId", "requestId", "path", "maxSize"?: <bytes> }`
- agent → server → UI: `file_get_chunk` `{ "clientId", "requestId", "offset": <bytes>, "data": "<base64>" }` (raw chunks ≤ 256 KiB)
- agent → server → UI: `file_get_result` `{ "clientId", "requestId", "ok", "path", "size", "error"? }` (terminal; sent after all chunks)

The server relay registers `requestId` → dashboard connection like `file_put`
and routes chunks/result to the owning dashboard only. The agent reads the file,
streams chunks, and finishes with a result; it rejects with `ok:false` on a
missing file or a size over `maxSize`.

`stat` is still derived by listing the parent directory (no dedicated stat event).
