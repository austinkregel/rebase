# Desktop app auto-update

Adopt the Tauri updater for the `rebase` desktop app, mirroring the working setup
in `mercs2-modkit`. **Independent of the indexer-signing work** (SIGNED-EXEC.md):
different key, different repo surface, different verifier.

## Trust model

- **Signing key = "key B"**, a *dedicated* minisign key, separate from the
  indexer's "key A". Blast-radius isolation: an app-updater key leak can't forge
  an indexer, and vice-versa.
- Private half (+ passphrase) → `rebase` repo Actions secrets
  (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- Public half → **pinned in `rebase`'s `tauri.conf.json`** (`plugins.updater.pubkey`).
- **Verifier = the Tauri updater in the app itself** — it will not install an
  artifact whose signature doesn't match the pinned pubkey. No custom code.

## Update UX (decided)

**Check on launch.** On startup the app queries the endpoint; if a newer version
is offered, it prompts ("vX.Y.Z is available — restart to update"), and on the
user's confirmation it downloads, installs, and relaunches
(`tauri-plugin-process`). Not silent — the user sees it and consents to the
relaunch, so an update never yanks the workbench out from under unsaved work.

## Endpoint

The app checks the **rebase repo's GitHub releases**:

```
https://github.com/austinkregel/rebase/releases/latest/download/latest.json
```

`latest.json` is a release asset (assembled in CI, below), so "latest release"
always resolves to the current manifest. No server to run.

## Platforms (all major distros + arches)

Six updater targets, matching the release matrix (AppImage is distro-agnostic, so
it covers "all major distros"):

| updater key | artifact |
| ----------- | -------- |
| `linux-x86_64` | `*.AppImage` |
| `linux-aarch64` | `*.AppImage` |
| `darwin-x86_64` | `*.app.tar.gz` |
| `darwin-aarch64` | `*.app.tar.gz` |
| `windows-x86_64` | `*-setup.exe` |
| `windows-aarch64` | `*-setup.exe` |

(macOS updates from `.app.tar.gz`, not the `.dmg` shown on the release page —
same as mercs2.)

## The five pieces

1. **`tauri.conf.json`** — `bundle.createUpdaterArtifacts: true`, and
   `plugins.updater { endpoints: ["…/releases/latest/download/latest.json"],
   pubkey: "<key B public>" }`.
2. **`src-tauri/Cargo.toml`** — add `tauri-plugin-updater` + `tauri-plugin-process`;
   register both in `lib.rs` (`generate_handler!` / `.plugin(...)`).
3. **`package.json`** — add `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`.
4. **App flow (Vue)** — on mount, `check()`; if an update is returned, surface a
   prompt through the existing notification/confirm surface; on accept,
   `downloadAndInstall()` then `relaunch()`. Guard so it runs once per launch and
   never blocks startup (fire-and-forget, desktop-only via `isTauri()`).
5. **`rebase`'s `release.yml`** — set the `TAURI_SIGNING_PRIVATE_KEY*` env on each
   platform build (so `createUpdaterArtifacts` emits the `.sig`), then add an
   `updater-manifest` job that downloads every platform artifact, assembles
   `latest.json` (`{version, pub_date, notes, platforms{key:{url,signature}}}`),
   and attaches it to the release — **hard-failing if any platform's artifact or
   `.sig` is missing** (a missing entry silently tells that platform "you're up to
   date" forever). This job is lifted almost verbatim from
   `mercs2-modkit/.github/workflows/release.yml`.

## What you set up (once)

- Generate **key B**: `tauri signer generate` (the command you already use) → a
  new minisign keypair, *distinct* from the indexer's key A.
- Add `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the
  **rebase** repo secrets.
- Hand me key B's **public** line to pin in `tauri.conf.json`.

**Recorded** (public, safe to store): key B's pubkey for `plugins.updater.pubkey`
is the Tauri-format base64 —
`dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc0OTI0OUY4RDJCOUNBQzIKUldUQ3lyblMrRW1TZENLQytEYlJXTjd2SnRRTUZUNS9xK1V5R0RuaEI3a0NrQkpqRytmbFJGM0gK`
(inner minisign key id `749249F8D2B9CAC2`). Secrets `TAURI_SIGNING_PRIVATE_KEY` +
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are already set on the `rebase` repo.

## Fail-loud

- CI: missing artifact or missing `.sig` → the manifest job fails the release
  (mercs2's rule). No half-published `latest.json`.
- App: a verification failure in the Tauri updater surfaces as an error in the
  update prompt, not a silent no-op.

## Files touched (all in `rebase`)

| File | Change |
| ---- | ------ |
| `src-tauri/tauri.conf.json` | `createUpdaterArtifacts`, `plugins.updater` |
| `src-tauri/Cargo.toml` + `lib.rs` | updater + process plugins |
| `package.json` | JS updater + process plugins |
| `src/…` (a small update service + prompt) | check-on-launch flow |
| `.github/workflows/release.yml` | signing env + `updater-manifest` job |

Nothing outside `rebase`. The control plane and `compute-agent` are untouched.

## Test plan

- **Unit**: the update service's "is there a newer version" / prompt-gating logic
  (pure, mock the updater API) — check-once-per-launch, desktop-only, no-op when
  already current.
- **Manual/e2e** (can't be unit-tested without a real signed release): tag a
  pre-release, confirm an older build detects it, prompts, installs, relaunches.
  Called out as manual rather than pretended-covered.
