# Direct mode + Tauri architecture

How the rebase desktop app talks to a machine **directly** (app ↔ agent over a
private network like ZeroTier), and how the same app still supports the
**relayed** path (app ↔ control plane ↔ agent). Decisions locked 2026-06-10.

This is the cross-component contract: the **agent** and **control-plane** work
(a separate effort) keys off the "Agent side" and "OIDC" sections; the **app**
work keys off "Tauri core" and "IPC contract".

```
DIRECT (single machine, on your VPN)
┌──────────────────────────────┐         wss + Bearer JWT          ┌───────────┐
│ rebase app                   │  ───────────────────────────────▶ │  agent    │
│  webview (Vue) ⇄ Rust core   │   {event,data} frames, 1:1        │ (direct   │
│  Rust owns: WS+TLS, OIDC,    │ ◀───────────────────────────────  │  listener)│
│  keychain, cert pin          │                                   └───────────┘
└──────────────────────────────┘
RELAYED (fleet / off-VPN) — unchanged from PROTOCOL.md
   webview ⇄ Rust core ──wss──▶ control plane ──signed_command──▶ agent
```

The wire protocol (`{event, data}` frames, `requestId`/`session` correlation,
dir_list/file_put/shell/…) is **identical** in both modes — see
[PROTOCOL.md](PROTOCOL.md). Direct mode is 1:1, so `clientId` routing is moot;
the agent accepts any `clientId` and answers with its own. The app's
`fileService`/`ptyService`/stores never learn which mode is active.

---

## Why Tauri, and where the connection lives

A browser PWA on `https://` cannot open a WebSocket to a self-signed-`wss://`
agent (mixed content + untrusted cert). The fix is to **move the WebSocket and
TLS into the Tauri Rust core**: Rust connects with `tokio-tungstenite` +
`rustls`, trusting/pinning the agent's self-signed cert from config. The
webview never makes the TLS connection — it talks to Rust over Tauri IPC. Rust
also owns the OIDC flow (system browser + loopback redirect) and token storage
(OS keychain). Use **Tauri 2**.

---

## Auth model — aut.hair Machine Tokens

IdP is `https://aut.hair` (Laravel Passport-style; repo
`github.com/austinkregel/aut.hair`). Auth uses **Machine Tokens**, confirmed
from its source:

- A **Machine Token** is an OAuth2 **`client_credentials`** access token: an
  **RS256 JWT**, `aud` = the machine OAuth client's `client_id`, carries the
  `openid` scope, **1-hour lifetime, no refresh token**. Generated in the
  aut.hair dashboard (Profile → Machine Tokens).
- **"IDE audience" = the `client_id` of a dedicated machine client.** Create one
  (e.g. named `rebase-ide`, grant `client_credentials`, scopes incl. `openid`);
  its numeric `client_id` is the audience the agent enforces.
- **No per-agent user allowlist.** The agent trusts the IdP: a valid, unexpired,
  correctly-audienced token ⇒ the holder may connect.
- **Revocation** — the agent verifies in two layers:
  1. **Offline JWT verification** — signature against `/oauth/jwks` (RS256),
     plus `iss`, `aud` == the IDE client_id, `exp` (with clock skew), and the
     `openid` scope. Fast, no network.
  2. **`/api/machine-info` probe** — present the token as Bearer; the IdP looks
     it up by `jti`, so a revoked token returns **401**. Run on connect and
     re-check periodically; drop the connection on 401. (Use machine-info, NOT
     `/api/userinfo` — userinfo runs on the user guard and a machine token has
     no user.) A 200 returns `{client_id, name, scopes}`, doubling as the
     agent's identity check.

Endpoints (from `/.well-known/openid-configuration`): token `/oauth/token`,
jwks `/oauth/jwks`, revoke `/oauth/revoke`, machine-info `/api/machine-info`.
There is **no introspection endpoint** and no dynamic client registration —
clients are created by hand in the dashboard.

### Agent config additions (for the agent/server effort)

```jsonc
{
  // ... existing agent config ...
  "directMode": {
    "enabled": true,
    "listenAddr": "0.0.0.0:7420",      // bind on the ZeroTier interface
    "tlsCertFile": "/etc/rebase/agent.crt",
    "tlsKeyFile":  "/etc/rebase/agent.key",
    "oidc": {
      "issuer":              "https://aut.hair",
      "audience":            "7",      // the rebase-ide machine client_id (REQUIRED match)
      "requiredScope":       "openid",
      "machineInfoProbe":    true,     // GET /api/machine-info to detect revocation
      "probeIntervalSec":    60
    }
  }
}
```

The agent needs **no OIDC client credentials of its own** — it only fetches the
public JWKS and probes machine-info with the *caller's* token.

### Agent-side direct listener (new code, agent effort)

- Inbound **WSS** server on `listenAddr`, serving the same `{event, data}`
  protocol the UI already speaks.
- **Auth on upgrade:** client sends the Machine Token. Prefer
  `Authorization: Bearer <jwt>` on the WS handshake; if the client lib can't set
  headers, accept a first `auth` frame `{ "token": "<jwt>" }` and refuse all
  other events until verified.
- Verify offline (JWKS + `iss`/`aud`/`exp`/scope) then probe machine-info; on
  failure close with a defined code. Re-probe on `probeIntervalSec`.
- Reuse the existing file/pty/dir handlers. In direct mode there is **no
  `signed_command`/cmdsig** — the JWT-authenticated socket is the trust
  boundary, so commands are handled directly.
- Emit responses with the agent's own `clientId` so the app's correlation
  (which keys on `requestId`/`session`, not `clientId`) just works.

---

## Tauri core (app effort — this repo)

The Rust core is the single owner of all networking and secrets. Layout:

```
src-tauri/
  Cargo.toml
  tauri.conf.json
  build.rs
  capabilities/default.json
  src/
    main.rs           entry
    lib.rs            Tauri builder, command/event registration
    config.rs         load ~/.config/rebase/config.toml (profiles + oidc)
    connection.rs     dial plan + Direct/Relay TLS (tokio-tungstenite)
    transport.rs      frame pump: socket <-> Tauri events; emit queue
    oidc.rs           discovery + client_credentials token minting + machine-info probe
    tokens.rs         OS keychain storage (keyring crate)
```

### Connection abstraction

```rust
enum Target {
    Direct { ws_url: String, cert_pin: Option<String> }, // wss://<vpn-ip>:7420
    Relay  { ws_url: String },                            // wss://control-plane/ws/dashboard
}
```

Both produce a `tokio-tungstenite` stream of `{event, data}` frames, attaching
`Authorization: Bearer <jwt>`. For an agent on `*.kregel.host` (the normal
case), Direct uses the **system trust store** like Relay — standard TLS, no
pinning. Pinning (a rustls config trusting one cert by SHA-256 fingerprint) is
the fallback, used only when a profile sets `cert_sha256` for a self-signed
agent. The frame pump forwards inbound frames to the webview as Tauri events and
drains an outbound queue fed by the `emit` command. `ping` → auto `pong` stays
in Rust.

### App config file (`~/.config/rebase/config.toml`)

The machine **client_id + client_secret** live in the OS keychain (set via the
`set_credentials` command), not this file. The file holds only the issuer and
the connection profiles.

```toml
[oidc]
issuer  = "https://aut.hair"
scopes  = ["openid"]            # client_credentials scopes for the machine token

[[profiles]]                    # a saved machine (direct)
name   = "homelab"
mode   = "direct"
ws_url = "wss://homelab.kregel.host:7420/ws"
# cert_sha256 omitted: the agent serves the publicly-trusted *.kregel.host
# wildcard, validated by standard TLS. Set cert_sha256 ONLY for a self-signed
# agent cert (the pinning fallback). The host must resolve to the agent's VPN IP.

[[profiles]]                    # the control plane (relay)
name   = "fleet"
mode   = "relay"
ws_url = "wss://control.example:8443/ws/dashboard"
```

---

## IPC contract (Rust ⇄ webview)

The webview's `src/transport/socket.ts` becomes a thin bridge over these. No
other app code changes.

**Commands (webview → Rust, `invoke`):**

| command | args | returns |
|---|---|---|
| `connect` | `{ profile: string }` | `()` — mints/uses a token, begins connecting; status via events |
| `disconnect` | `()` | `()` |
| `emit` | `{ event: string, data: object }` | `bool` (queued) |
| `set_credentials` | `{ token?: string, clientId?: string, clientSecret?: string }` | `()` — store in keychain (a static token OR client creds to auto-mint) |
| `logout` | `()` | `()` — revoke + clear keychain |
| `auth_status` | `()` | `{ authenticated: bool, clientId?: string, name?: string }` (via machine-info) |
| `list_profiles` | `()` | `Profile[]` |

**Events (Rust → webview, `listen`):**

| event | payload | meaning |
|---|---|---|
| `cp://frame` | `{ event, data }` | one inbound protocol frame |
| `cp://status` | `{ status: "connecting"\|"open"\|"closed" }` | connection state |
| `cp://auth` | `{ authenticated, user? }` | auth changed |

So `ControlPlaneSocket.emit(event, data)` → `invoke('emit', {event, data})`,
inbound `cp://frame` → existing dispatch, and `cp://status` drives the same
status handlers. The `Rpc`/`requestId` correlation layer is unchanged.

---

## Build / threat notes

- Per-platform bundles (macOS/Windows/Linux), each a self-contained app + the
  config file. Not one universal binary.
- Bearer tokens are sender-unconstrained; the ZeroTier + pinned-cert + WSS
  boundary is the practical protection. DPoP / mTLS-bound tokens are a future
  hardening if needed.
- Tokens live in the OS keychain, never in the webview or `localStorage`.
- Direct mode has no cmdsig; the JWT-authenticated WSS channel is the trust
  boundary. Keep the agent's direct listener bound to the VPN interface.
