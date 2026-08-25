# Signed-executable trust for the Crucible indexer

## Problem this replaces

Today the app trusts the indexer binary two ways, both brittle:

- A **SHA-256 pin** (`INDEXER_SHA256` + `INDEXER_VERSION` in `services/crucible.ts`)
  baked into the app — it went stale the moment a new indexer shipped, and every
  release means editing a hash.
- A **reactive exec-allowlist grant** (`grantExec`/`execWithGrant`) that silently
  widens the operator's control-plane allowlist to let the indexer run — a fragile
  round-trip that fails silently (it swallows errors and lets a retry "surface"
  the block) and depends on a control plane we don't want in the loop.

Both go away. Trust moves to a **signature**: CI signs each released binary with a
private key held in GitHub Actions secrets; the agent verifies it against a
**public key pinned in the agent's config** and, on a valid signature, runs the
binary **regardless of the operator allowlist**. This generalises — *any* binary
signed with the trusted key is auto-trusted, which is the "don't make me
whitelist my own programs" goal.

## Trust model (state it plainly)

- **Root of trust:** the release signing **public key, pinned in `compute-agent`'s
  config**. A compromised control plane cannot change it; a compromised github.com
  cannot change it. Rotating it is a config edit (the "semi-dynamic" knob), not a
  rebuild.
- **What a signature attests:** *provenance* — "this is the binary our release
  pipeline produced" — **not** safety. A signed binary still does whatever it does
  when run; that's fine for the indexer, and the operator allowlist still governs
  every *unsigned* command.
- **Exposure:** the **private key lives in GitHub Actions secrets**. A secrets
  leak = "sign anything the agents will trust." Mitigate with a **dedicated**
  signing key (not reused for anything else, revocable by rotating the pinned
  pubkey), passphrase-protected, and Actions **environment protection** on the
  release job. This is the accepted trade for hands-off CI signing.
- **Not via `github.com/<user>.keys`:** deliberately. To appear there a key must be
  a GitHub *authentication* key, i.e. a push credential — and a *software* key in
  CI must not double as repo write access. Pinning the pubkey in config avoids that
  coupling and removes any github.com dependency from the exec path. `.keys` /
  hardware-key signers can be added later as another signer type (see Seams).

## Key management

- **Keypair:** Ed25519 in **minisign** format — the same shape your Tauri updater
  uses (`tauri signer` is minisign underneath). Small, one-line public key, mature
  tooling on both the signing and verifying side.
- **Generate** (once, locally): `rsign2 generate` (or `minisign -G`) →
  `minisign.key` (passphrase-encrypted) + `minisign.pub`.
- **Secrets** (rebase-indexer repo → Actions):
  - `MINISIGN_SECRET_KEY` — contents of `minisign.key`
  - `MINISIGN_PASSWORD` — its passphrase
- **Pin the public key** in `compute-agent` config (see schema). The default
  shipped config carries the current release pubkey; operators can override.

## Signing (CI, in `rebase-indexer`'s `release.yml`)

Fully automated — no touch. After each target binary is built, sign it directly
(one detached signature per artifact; no manifest needed since there's no
per-file touch cost):

```
rsign2 sign -s "$MINISIGN_SECRET_KEY_FILE" -x rebase-indexer-linux-x86_64.minisig \
  rebase-indexer-linux-x86_64      # passphrase via MINISIGN_PASSWORD env
```

Upload both `rebase-indexer-<target>` and `rebase-indexer-<target>.minisig` as
release assets. (Exact CLI/flag choice — `rsign2` vs `minisign` vs Tauri's signer
— is a tooling detail to finalise; `rsign2` reads the passphrase from env cleanly,
which CI wants.)

## Distribution

The GitHub release for a version carries, per target:

```
rebase-indexer-linux-x86_64
rebase-indexer-linux-x86_64.minisig
```

No control-plane involvement. `compute-agent-server` / `backup-server-access-main`
are **untouched** — nothing to deploy to the frozen box.

## Verification (in `compute-agent`)

The agent gains a signature check that runs **before** it rejects a command as
not-allowlisted (`pkg/admin/runner.go`, `isAllowed`, currently line ~718):

1. If `strict` trust mode is on → skip entirely (allowlist only).
2. Else, if `argv[0]` is an **absolute path to an existing file**, look for
   `<path>.minisig` beside it and verify it against the pinned public key(s) using
   a native minisign verifier (`aead.dev/minisign` — no `minisign` binary, no
   `sha256sum`, works on every OS incl. Windows agents; the same library the Go
   tests use to mint a keypair and sign fixtures).
3. Valid signature → **allow**, regardless of the operator allowlist. Invalid or
   missing → fall through to the normal allowlist decision (i.e. still blocked,
   and blocked **loudly** — the 126 message names what happened).

**Cost control:** verifying re-reads the (~180 MB) binary, so memoise the result
by `(path, size, mtime)`; re-verify only when the file changes. Public keys are
static config, so no fetch/cache/TLS in the hot path.

**Scope:** the exemption keys on `argv[0]` being a signed file. Args are the
caller's business (the IDE confines cwd itself, per the existing `Exec` contract).
Signing attests the *binary*, not the invocation.

## Config schema (`compute-agent`, `admin` block, JSON)

```jsonc
"admin": {
  // Pinned release-signing public key(s), minisign base64 (optional "minisign:"
  // prefix). Editable = rotation without a rebuild (the "semi-dynamic pin").
  // Empty = signature trust disabled.
  "trustedSigners": ["RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFU3"],
  // true = ignore signatures entirely; the command allowlist is the only
  // authority (for a locked-down fleet). Default false.
  "signatureTrustStrict": false
}
```

Read at startup by `NewRunner`, parsed into `[]minisign.PublicKey`, and consulted
by `permitted()` = `isAllowed() || isSignedTrusted()`. **Implemented** in
`pkg/config/config.go` (fields) and `pkg/admin/signature.go` (verify + memo),
with `pkg/admin/signature_test.go` covering: valid sig allowed, tampered/
untrusted-key/missing-sig blocked, strict-mode bypass, and no-signers.

## What this deletes in `rebase` (`services/crucible.ts`)

- `INDEXER_SHA256` + the per-release hash maintenance — **gone**.
- `currentChecksum` / the `sha256sum`/`shasum` step — **gone** (a signature
  replaces the hash for both presence and integrity; presence becomes "is the
  binary + its `.minisig` present").
- `grantExec` / `execWithGrant` and all reactive allowlist widening — **gone**.
- `runIndexer` just execs; a 126 now surfaces a **loud, specific** error via the
  existing "Crucible indexing failed" notification.
- Download now also fetches `<binary>.minisig` and places it beside the binary in
  the cache dir so the agent can find it.

## Fail-loud behaviour

No silent fallbacks. Every refusal names the cause and the fix:

- Binary blocked & unsigned/badly-signed → "the indexer at `<path>` has no valid
  signature from a trusted key — its release may be unsigned or the pinned key is
  wrong."
- Download tool blocked → "`curl` (or `wget`) is blocked by the agent allowlist —
  allow it on your control plane so Crucible can fetch the indexer." (See Seams.)

## Seams left open (honest scope of v1)

- **`curl`/`wget` still needed** to *download* the binary, so they must be in the
  operator allowlist (fail-loud if not). Removing that is the **agent-self-fetch**
  follow-up (agent downloads + verifies via a signed control-plane command) — a
  clean later step, not required for v1.
- **`.keys` / hardware-key signers** and an **offline-root signed manifest** are
  future `signers` entry types; the verify flow doesn't change, only how a signer
  is resolved.

## Repos, order, and what you set up

| Step | Repo | Change |
| ---- | ---- | ------ |
| 1 | `rebase-indexer` | `release.yml` signing step; cut a **new signed release** |
| 2 | `compute-agent` | minisign verifier + `[exec.trust]` config + `isAllowed` hook + Go tests; **tag + deploy** to hosts |
| 3 | `rebase` | drop pin/`sha256sum`/grant; fetch `.minisig`; loud errors; update tests |

**You do, once:** generate the keypair, add `MINISIGN_SECRET_KEY` +
`MINISIGN_PASSWORD` to the rebase-indexer Actions secrets, and put the public key
in the `compute-agent` config (default + each host).

## Test plan

- **`compute-agent` (Go):** a fixture keypair signs a temp binary → allowed; a
  tampered binary, a missing `.minisig`, and a signature from a non-pinned key →
  blocked; `strict = true` ignores a valid signature. Keypair minted in-test.
- **`rebase` (TS):** `INDEXER_SHA256` pin removed; the download path requests the
  `.minisig` asset; grant-removal doesn't strand the flow; the new 126 error text
  is asserted.
