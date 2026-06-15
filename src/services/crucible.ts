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
/** Stable absolute location on the (unix) agent for the cached binary. The name
 *  is version-less so the allowlist entry never changes; a `.version` marker
 *  tracks which release is installed so upgrades re-download. */
const AGENT_BIN_DIR = '/tmp/rebase/bin'
const AGENT_BIN_NAME = 'rebase-indexer'
const AGENT_BIN_PATH = `${AGENT_BIN_DIR}/${AGENT_BIN_NAME}`
const AGENT_VERSION_MARKER = `${AGENT_BIN_DIR}/.version`
/** Indexing/packing can take minutes; give exec plenty of head-room. */
const BUILD_TIMEOUT_SEC = 30 * 60
const BUILD_TIMEOUT_MS = BUILD_TIMEOUT_SEC * 1000 + 5_000
/** Binary download (agent → GitHub) is quick but allow for a slow link. */
const FETCH_TIMEOUT_SEC = 10 * 60
const FETCH_TIMEOUT_MS = FETCH_TIMEOUT_SEC * 1000 + 5_000

function releaseUrl(asset: string): string {
  return `https://github.com/${INDEXER_REPO}/releases/download/${INDEXER_VERSION}/${asset}`
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
 * a ~180MB binary over the control-plane socket is a non-starter. The exact
 * download command + the binary path are allowlisted first (tightly scoped).
 */
async function ensureBinary(clientId: string, projectId: string): Promise<string> {
  const agent = useAgentsStore().byId(clientId)
  const asset = indexerAsset(agent?.platform, agent?.arch)

  // If the binary is already there, reuse it — only re-download when a version
  // marker explicitly says a *different* release is installed. (Presence is the
  // primary signal; a missing/unreadable marker must NOT force a re-download.)
  let present = false
  try {
    const entries = await fileService.list(clientId, AGENT_BIN_DIR)
    present = entries.some((e) => e.name === AGENT_BIN_NAME)
  } catch {
    /* dir doesn't exist yet */
  }
  if (present) {
    let installed: string | null = null
    try {
      installed = (await fileService.read(clientId, AGENT_VERSION_MARKER)).trim()
    } catch {
      installed = null // no marker — assume current and keep the existing binary
    }
    if (installed === null || installed === INDEXER_VERSION) return AGENT_BIN_PATH
  }

  const url = releaseUrl(asset)
  const curlCmd = `curl -fSL ${url} -o ${AGENT_BIN_PATH}`
  const wgetCmd = `wget -O ${AGENT_BIN_PATH} ${url}`

  // Authorize exactly the commands we run (allowlist is prefix-matched), then
  // let the agent fetch the binary itself.
  await grantExec(projectId, [curlCmd, wgetCmd, AGENT_BIN_PATH])
  await fileService.mkdir(clientId, AGENT_BIN_DIR)

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
  await fileService.chmod(clientId, AGENT_BIN_PATH, '755')
  // Record the installed version so the next build can skip the download.
  await fileService.write(clientId, AGENT_VERSION_MARKER, INDEXER_VERSION).catch(() => {})
  return AGENT_BIN_PATH
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
    const bytes = await fileService.readBytes(clientId, archivePath)
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
