# Control-plane policy syndication — trusted signers (+ an allowlist UI)

A control-plane feature (not the rebase app): extend the CP's existing
**exec-allowlist syndication** to **trusted signing keys**, and give operators a
**Policy** UI to manage both. Central rotation replaces per-agent config edits and
the app's silent auto-widening. Spans three repos — `compute-agent-server`
(backend), `compute-agent` (agent), `backup-server-access/client` (Vue 3 UI).

It mirrors the allowlist path one-for-one, because that path already exists and
works.

## Trust model (state it plainly)

The CP **already** syndicates the exec allowlist and already has command-execution
authority over agents (the command channel mandates signed commands). Syndicating
signing keys is the *same* authority, not a new grant: a compromised CP pushing a
rogue trusted key ≈ a compromised CP pushing a rogue allowlist entry. So this is
consistent with the trust the fleet already places in the CP — **provided** the
trusted-signers surface gets the same admin-gating + audit the allowlist is slated
for (server handoff doc, M2).

The escape hatch is preserved: the agent's **local `admin.trustedSigners`** (the
release key I already pinned in `defaultConfig`) stays as a **CP-independent
anchor**, merged with the syndicated set under a `merge | cp-authoritative` mode —
exactly the local-floor model the allowlist already uses.

## Server — `compute-agent-server`

Mirror the allowlist surface:

- **Store:** a `trustedsigners.Store` modeled on `allowlist.Store`
  (`Add/Remove/Replace/Commands/Entries/IsEmpty`, prefix-free — keys are opaque),
  persisted (`trusted-signers.json`, `TRUSTED_SIGNERS_STATE_PATH`), seeded from
  config on first run.
- **Push:** on agent connect *and* on change, `ws.SendSignedCommand(store,
  clientID, "trusted_signers", {"signers": [...]})` — the twin of the
  `exec_allowlist` push at `internal/server/server.go:86-88` and `pushAllowlist`
  (`internal/api/routes.go`).
- **Admin API:** `GET/PUT/POST /api/server/trusted-signers`, behind the same admin
  middleware and audit log as `/api/server/exec-allowlist`.
- **Validation:** each entry must be a well-formed minisign public key (base64,
  `RW…`, decodes to the right length/alg) — reject junk, mirroring
  `allowlist.ValidateCommand`.

## Agent — `compute-agent`

- **Transport:** a `transport.TrustedSigners` message + a `case "trusted_signers":`
  in `pkg/transport/transport.go` (twin of `exec_allowlist` at line 1070).
- **Handler:** `handleTrustedSigners(msg)` in `internal/app/agent.go` →
  `combineSigners(a.cfg.Admin.TrustedSignersMode, a.cfg.Admin.TrustedSigners,
  msg.Signers)` → `a.admin.SetTrustedSigners(effective)`. A verbatim mirror of
  `handleExecAllowlist` / `combineAllowlist`, same two modes.
- **Runner:** today `trustedKeys` is parsed once in `NewRunner` and read lock-free.
  To accept runtime updates, guard it with a `trustedMu sync.RWMutex`; add
  `SetTrustedSigners(entries []string)` that re-parses under the lock (reusing
  `parseTrustedSigners`); `isSignedTrusted` reads under `RLock`. (This evolves the
  already-committed signature-trust code to be updatable.)
- **Config:** `admin.trustedSignersMode: "merge" | "cp-authoritative"` (default
  `merge`), mirroring `allowlistMode`. Local `admin.trustedSigners` is the anchor.
- **Ordering:** before the first push, the local anchor governs — so a signed
  first-party binary still runs on a fresh agent that hasn't heard from the CP yet
  (or one running `cp-authoritative` with an empty CP list still honors nothing but
  the CP — operator's choice).

## Client — `backup-server-access/client` (Vue 3 + Vite)

A new **Policy** view (`src/views/PolicyView.vue` + a route in `router.js`), using
the existing `lib/auth.js` for admin auth and the app's established API-call
pattern. Two panels — this also fills the allowlist's missing UI (handoff doc):

- **Exec allowlist:** list entries with provenance, add/remove, the confirm-empty
  guard the server already enforces, and "N agents updated" feedback. Talks to
  `GET/PUT/POST /api/server/exec-allowlist`.
- **Trusted signers:** list keys (key id + label/comment), paste a minisign pubkey
  to add, remove/rotate, "N agents updated" feedback, and a clear note that *a
  binary signed by any listed key runs regardless of the allowlist*. Talks to
  `GET/PUT/POST /api/server/trusted-signers`.

Surface the audit trail (actor + diff) if the endpoints return it.

## Wire / data

- `trusted_signers` command payload: `{ "signers": ["RW…", …] }` (twin of
  `exec_allowlist`'s `{ "commands": [...] }`).
- Store entry: the minisign pubkey base64, plus optional `label` / `source` /
  `addedBy` for the UI + audit (kept server-side; the agent only needs the keys).

## Security & caveats (honest)

- **Admin-gate + audit** the trusted-signers endpoints — a rogue key is *powerful*
  (any binary it signs bypasses the allowlist), so it deserves at least the
  allowlist's controls.
- The **syndication channel is integrity-protected** already (mandatory signed
  commands) — an on-path attacker can't inject a key without the CP's signing key.
- The **local anchor + `cp-authoritative`** mode give operators the CP-independence
  choice, same as the allowlist.
- The committed local pin (release key in `defaultConfig`) becomes the **default
  anchor**; syndication adds/rotates on top of it.

## Files touched

| Repo | Files |
| ---- | ----- |
| `compute-agent-server` | new `internal/trustedsigners` store; `internal/api/routes.go` (+ handlers, audit); `internal/server/server.go` (push on connect); config seed |
| `compute-agent` | `pkg/transport/transport.go` (+ type + case); `internal/app/agent.go` (handler + `combineSigners`); `pkg/admin/runner.go` (mutex + `SetTrustedSigners`); `pkg/config/config.go` (`TrustedSignersMode`) |
| `backup-server-access/client` | `src/views/PolicyView.vue`, `src/router.js`, an API helper |

## Tests

- **Agent:** `combineSigners` merge vs cp-authoritative; `SetTrustedSigners`
  re-parses and is race-safe (concurrent read/update); a syndicated key enables
  trust at runtime; the local anchor still works before any push.
- **Server:** store `Add/Remove/Replace` + validation rejects junk; endpoints
  admin-gated; the connect push includes the signers.
- **Client:** the Policy view lists/adds/removes against a mocked API (if the
  client has a test harness; otherwise a manual checklist).

## Build order

1. **Agent** — runtime-updatable `trustedKeys` (mutex + `SetTrustedSigners`) +
   transport case + handler + mode. Self-contained, unit-testable, no server/UI.
2. **Server** — store + endpoints + push on connect/change (deploy a new CP).
3. **Client** — the Policy view (allowlist + trusted signers).
