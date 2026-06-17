import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/transport/contract'
import { fileService } from '@/services/fileService'
import { bytesToBase64 } from '@/transport/encoding'
import { notify } from '@/services/notifications'
import { platform } from '@/services/platform'
import { useAgentsStore } from '@/stores/agents'
import { useSessionStore } from '@/stores/session'
import { useSettingsStore } from '@/stores/settings'
import type { Project } from '@/stores/projects'
import { appendSystemNote, setIndexState, setIndexPhase } from '@/services/crucibleState'

/**
 * Crucible index lifecycle. The indexer runs on the *agent* (where the project
 * files live): we upload the bundled `rebase-indexer` binary, authorize it in
 * the control plane's exec allowlist, build the index in full, pack it into one
 * archive, download that single file, and extract it into a local cache that
 * `search_code` (Tauri) queries. All agent I/O reuses fileService primitives.
 */

/** Indexer release (github.com/austinkregel/rebase-indexer) the agent pulls. */
const INDEXER_REPO = 'austinkregel/rebase-indexer'
const INDEXER_VERSION = 'v0.0.3'
/**
 * Pinned SHA-256 of each release asset for INDEXER_VERSION. The agent downloads
 * the binary directly from GitHub, so we verify it against these hashes (shipped
 * inside the signed app) before running it — a compromised release/CDN can't
 * yield code execution on the agent. MUST be updated alongside INDEXER_VERSION.
 */
const INDEXER_SHA256: Record<string, string> = {
  'rebase-indexer-linux-x86_64': '1356f1fd74dd5dc6edbd79fcdbb584795162fd3ffc08931484f3619953c1d891',
  'rebase-indexer-linux-arm64': 'c1d5df1007b929e3ca37dc47d4937a61d0a94bb6639f79fac69eecded992c985',
  'rebase-indexer-macos-arm64': '0c72b308187eff77e3c4e4a9dc8801bccdb66bb113b021e2645acb1069b44bcb',
}
/** Indexing/packing can take minutes; give exec plenty of head-room. */
const BUILD_TIMEOUT_SEC = 30 * 60
const BUILD_TIMEOUT_MS = BUILD_TIMEOUT_SEC * 1000 + 5_000
/** Binary download (agent → GitHub) is quick but allow for a slow link. */
const FETCH_TIMEOUT_SEC = 10 * 60
const FETCH_TIMEOUT_MS = FETCH_TIMEOUT_SEC * 1000 + 5_000

function releaseUrl(asset: string): string {
  return `https://github.com/${INDEXER_REPO}/releases/download/${INDEXER_VERSION}/${asset}`
}

/**
 * Where the indexer is cached on the agent. Prefer the agent user's home (from
 * telemetry) so it's persistent (reused across projects/reboots, not re-fetched)
 * and not under world-writable /tmp; the `.rebase` dir is chmod 700 so another
 * local user can't plant a malicious binary. Falls back to /tmp only when the
 * agent hasn't reported a home yet.
 */
function agentDirs(home?: string): { root: string; bin: string; binPath: string; marker: string } {
  const base = home && home.trim() ? `${home.replace(/\/+$/, '')}/.rebase` : '/tmp/rebase'
  return { root: base, bin: `${base}/bin`, binPath: `${base}/bin/rebase-indexer`, marker: `${base}/bin/.version` }
}

/** One search hit returned by the `search_code` Tauri command. */
export interface Hit {
  relative: string
  language: string
  line_start: number
  line_end: number
  distance: number
  text: string
}

/** Map an agent's reported platform/arch onto a release asset name
 *  (github.com/austinkregel/rebase-indexer releases). */
export function indexerAsset(platformName?: string, arch?: string): string {
  const p = (platformName ?? '').toLowerCase()
  const a = (arch ?? '').toLowerCase()
  const isArm = a.includes('arm') || a.includes('aarch64')
  if (/windows/.test(p)) {
    // The agent-side cache path + chmod assume a unix host.
    throw new Error('Crucible has no indexer build for Windows agents yet')
  }
  if (p.includes('darwin') || p.includes('mac')) return isArm ? 'rebase-indexer-macos-arm64' : 'rebase-indexer-macos-x86_64'
  return isArm ? 'rebase-indexer-linux-arm64' : 'rebase-indexer-linux-x86_64'
}

/** Local cache dir (under the app's data dir) that holds the extracted index. */
export function localIndexDir(clientId: string, root: string): Promise<string> {
  return invoke<string>('crucible_local_index_dir', { clientId, root })
}

/**
 * Make sure the indexer binary exists on the agent. The agent downloads the
 * matching release asset *directly from GitHub* (curl, wget fallback) — pushing
 * a ~180MB binary over the control-plane socket is a non-starter. We then verify
 * its SHA-256 against the pinned hash before running it, and cache it in the
 * agent's home (`~/.rebase/bin`, chmod 700) so it persists and can't be planted.
 */
async function ensureBinary(clientId: string, projectId: string): Promise<string> {
  const agent = useAgentsStore().byId(clientId)
  const asset = indexerAsset(agent?.platform, agent?.arch)
  const { root, bin, binPath, marker } = agentDirs(agent?.home)

  // Skip the (re)download when this version is already installed+verified. Probe
  // the version marker with file_get (read) — NOT dir_list, which the agent
  // restricts to its browse roots. The marker is written only AFTER checksum
  // verification, so a matching marker means the cached binary is trusted.
  try {
    const installed = (await fileService.read(clientId, marker)).trim()
    if (installed === INDEXER_VERSION) return binPath
  } catch {
    /* no marker (or unreadable) → (re)install */
  }

  const url = releaseUrl(asset)
  const curlCmd = `curl -fSL ${url} -o ${binPath}`
  const wgetCmd = `wget -O ${binPath} ${url}`
  const sha256Cmd = `sha256sum ${binPath}`
  const shasumCmd = `shasum -a 256 ${binPath}`

  // Authorize exactly the commands we run (allowlist is prefix-matched), then
  // let the agent fetch + verify the binary itself.
  await grantExec(projectId, [curlCmd, wgetCmd, sha256Cmd, shasumCmd, binPath])
  await fileService.mkdir(clientId, bin)
  // Lock down the cache root so other local users can't tamper with the binary.
  await fileService.chmod(clientId, root, '700').catch(() => {})

  const opts = { timeoutSec: FETCH_TIMEOUT_SEC, timeoutMs: FETCH_TIMEOUT_MS }
  const curl = await fileService.exec(clientId, curlCmd, undefined, opts)
  if (!curl.ok || curl.code !== 0) {
    const wget = await fileService.exec(clientId, wgetCmd, undefined, opts)
    if (!wget.ok || wget.code !== 0) {
      const detail = [curl, wget]
        .map((r, i) => `${i === 0 ? 'curl' : 'wget'} exit ${r.code}: ${(r.stderr || r.error || '').trim()}`)
        .join('; ')
      throw new Error(`agent could not download the indexer (${detail})`)
    }
  }

  await verifyChecksum(clientId, binPath, asset, [sha256Cmd, shasumCmd])

  await fileService.chmod(clientId, binPath, '755')
  // Record the installed version (only reached after a verified install).
  await fileService.write(clientId, marker, INDEXER_VERSION).catch(() => {})
  return binPath
}

/**
 * Verify the downloaded binary against the pinned SHA-256, deleting it and
 * throwing on mismatch — we refuse to execute a binary that doesn't match the
 * release we shipped hashes for (supply-chain / MITM defense). Uses `sha256sum`
 * (linux) or `shasum -a 256` (darwin) on the agent.
 */
async function verifyChecksum(
  clientId: string,
  binPath: string,
  asset: string,
  cmds: string[],
): Promise<void> {
  const expected = INDEXER_SHA256[asset]
  if (!expected) {
    throw new Error(`Crucible has no pinned checksum for ${asset} @ ${INDEXER_VERSION}`)
  }
  let got = ''
  const failures: string[] = []
  for (const cmd of cmds) {
    const res = await fileService.exec(clientId, cmd, undefined, { timeoutSec: 120, timeoutMs: 125_000 })
    if (res.ok && res.code === 0) {
      const out = (res.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase()
      if (out) {
        got = out
        break
      }
    }
    const tool = cmd.split(' ')[0]
    const why =
      res.code === 126
        ? 'blocked by the exec allowlist'
        : res.code === 127
          ? 'not installed / not on PATH'
          : (res.stderr || res.error || `exit ${res.code}`).trim()
    failures.push(`${tool}: ${why}`)
  }
  if (!got) {
    await fileService.delete(clientId, binPath).catch(() => {})
    throw new Error(
      `Couldn't verify the indexer — no usable checksum tool (${failures.join('; ')}). ` +
        'Allow-list `sha256sum` (or `shasum -a 256`) on the agent, then retry. ' +
        'Refusing to run an unverified binary.',
    )
  }
  if (got !== expected) {
    await fileService.delete(clientId, binPath).catch(() => {})
    throw new Error(
      `Indexer checksum MISMATCH for ${asset} (expected ${expected.slice(0, 12)}…, got ${got.slice(0, 12)}…). ` +
        'The downloaded binary does not match the pinned release — refusing to run it.',
    )
  }
}

/**
 * Ensure `commands` are in the agent's exec allowlist so the agent will run
 * them. The PUT replaces the whole list, so we GET → merge → PUT. An empty list
 * already means allow-all (nothing to do). A real grant is recorded in the chat
 * log + a toast because it's a security-relevant change made on the user's behalf.
 */
async function grantExec(projectId: string, commands: string[]): Promise<void> {
  const cp = useSessionStore().selectedControlPlane?.name
  let current: string[]
  try {
    current = await platform.getExecAllowlist(cp)
  } catch {
    return // best-effort: if we can't read policy, let the build surface any block
  }
  if (current.length === 0) return // empty = allow-all
  const missing = commands.filter((c) => !current.includes(c))
  if (!missing.length) return
  await platform.setExecAllowlist([...current, ...missing], cp)
  appendSystemNote(
    projectId,
    `Authorized Crucible on this server — added ${missing.map((m) => `\`${m}\``).join(', ')} to the control-plane exec allowlist.`,
  )
  notify.info('Crucible updated the exec allowlist', {
    source: 'Crucible',
    body: missing.join('\n'),
  })
}

/** Run the indexer on the agent, throwing on a non-zero exit. */
async function runIndexer(clientId: string, args: string[], cwd: string): Promise<void> {
  const res = await fileService.exec(clientId, args.join(' '), cwd, {
    timeoutSec: BUILD_TIMEOUT_SEC,
    timeoutMs: BUILD_TIMEOUT_MS,
  })
  if (!res.ok || res.code !== 0) {
    const detail = (res.stderr || res.error || `exit ${res.code}`).trim()
    throw new Error(detail || 'indexer failed')
  }
}

/** Whether a local index already exists for a project's primary root. */
export async function hasLocalIndex(clientId: string, root: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('crucible_index_exists', { clientId, root })
  } catch {
    return false
  }
}

/**
 * Full build → pack → download → extract for a project's primary root, driving
 * the reactive status used by the panel + status bar. Failures raise a sticky
 * notification with a Retry action.
 */
export async function rebuild(project: Project): Promise<void> {
  const root = project.rootPaths[0]
  const { clientId, id: pid } = project
  if (!root) return
  if (!isTauri()) {
    notify.warning('Crucible runs in the desktop app', { source: 'Crucible' })
    return
  }

  const { ollamaUrl, embedModel } = useSettingsStore().indexing
  const indexDir = `${root}/.rebase-index`
  const archivePath = `${root}/.rebase-index.tgz`
  try {
    setIndexState(pid, { phase: 'uploading', error: undefined })
    const bin = await ensureBinary(clientId, pid)

    setIndexPhase(pid, 'building')
    await runIndexer(
      clientId,
      [bin, 'index', root, '--ollama', ollamaUrl, '--model', embedModel],
      root,
    )

    setIndexPhase(pid, 'packing')
    await runIndexer(clientId, [bin, 'pack', '--index', indexDir, '--out', archivePath], root)

    setIndexPhase(pid, 'downloading')
    // The packed index can be sizable and streams over the WS in chunks, so
    // allow a high cap + long timeout rather than the default 50MB/30s.
    const bytes = await fileService.readBytes(clientId, archivePath, 512 * 1024 * 1024, FETCH_TIMEOUT_MS)
    await invoke('crucible_extract_index', { archive: bytesToBase64(bytes), clientId, root })
    await fileService.delete(clientId, archivePath).catch(() => {})

    setIndexState(pid, { phase: 'ready', lastIndexedAt: Date.now(), error: undefined })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setIndexState(pid, { phase: 'error', error: msg })
    notify.error('Crucible indexing failed', {
      source: 'Crucible',
      body: msg,
      actions: [{ label: 'Retry', run: () => void rebuild(project) }],
    })
  }
}

/**
 * Best-effort refresh when a project is opened: only if an index already exists
 * locally (so we never auto-build/embed without an explicit action). The indexer
 * is incremental, so this is cheap when nothing changed.
 */
export async function maybeAutoRefresh(project: Project): Promise<void> {
  const root = project.rootPaths[0]
  if (!root) return
  if (await hasLocalIndex(project.clientId, root)) {
    setIndexState(project.id, { phase: 'ready' })
    void rebuild(project)
  }
}

/** Semantic retrieval over a project's local index (top-k chunks). */
export async function retrieve(
  clientId: string,
  root: string,
  query: string,
  k: number,
): Promise<Hit[]> {
  const indexPath = await localIndexDir(clientId, root)
  const { ollamaUrl, embedModel } = useSettingsStore().indexing
  return invoke<Hit[]>('search_code', {
    indexPath,
    query,
    ollama: ollamaUrl,
    model: embedModel,
    k,
  })
}
