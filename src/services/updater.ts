import { isTauri } from '@/transport/contract'
import { confirm } from '@/services/confirm'
import { notify } from '@/services/notifications'

/**
 * Desktop auto-update. On launch the app asks GitHub whether a newer release
 * exists; if one does the user is asked before anything is downloaded, and the
 * app relaunches into it on their say-so. See docs/AUTO-UPDATE.md.
 *
 * Deliberately not silent: an update that installs itself would yank the
 * workbench out from under unsaved buffers. The prompt is the feature.
 *
 * Verification is the Tauri updater's, not ours — it refuses any artifact whose
 * minisign signature doesn't match the pubkey pinned in tauri.conf.json, so
 * there is no signature handling in this file by design.
 */

/** The updater surface this module needs, narrowed so tests can stand it in. */
export interface UpdateHandle {
  version: string
  currentVersion: string
  downloadAndInstall(): Promise<void>
}

export interface UpdaterDeps {
  /** Resolves to the available update, or null when already current. */
  check(): Promise<UpdateHandle | null>
  relaunch(): Promise<void>
  isTauri(): boolean
  confirm: typeof confirm
  notify: typeof notify
}

// Lazy so the browser build never imports the Tauri plugins.
const tauriDeps: UpdaterDeps = {
  check: async () => {
    const { check } = await import('@tauri-apps/plugin-updater')
    return (await check()) as UpdateHandle | null
  },
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  },
  isTauri,
  confirm,
  notify,
}

/** One check per launch. A second call is a no-op, not a second prompt. */
let checked = false

/** Test seam — resets the once-per-launch latch. */
export function _resetUpdater(): void {
  checked = false
}

export type UpdateOutcome =
  | 'skipped-not-desktop'
  | 'skipped-already-checked'
  | 'up-to-date'
  | 'declined'
  | 'installing'
  | 'failed'

/**
 * Check for an update and, if the user accepts, install and relaunch.
 *
 * Never throws: this runs fire-and-forget on startup, and a GitHub outage or a
 * rate-limited endpoint must not surface as an unhandled rejection during boot.
 * A failed *check* stays quiet (the user did not ask for it and can do nothing
 * about it); a failed *install* is surfaced, because by then they said yes and
 * are waiting for something to happen.
 */
export async function checkForUpdate(deps: UpdaterDeps = tauriDeps): Promise<UpdateOutcome> {
  if (!deps.isTauri()) return 'skipped-not-desktop'
  if (checked) return 'skipped-already-checked'
  checked = true

  let update: UpdateHandle | null
  try {
    update = await deps.check()
  } catch {
    // Offline, rate-limited, or no release yet. Silent by design.
    return 'failed'
  }
  if (!update) return 'up-to-date'

  const accepted = await deps.confirm({
    title: `Version ${update.version} is available`,
    message: `You're on ${update.currentVersion}. Downloading takes a moment, and rebase will restart to finish installing.`,
    confirmLabel: 'Update and restart',
  })
  if (!accepted) return 'declined'

  try {
    await update.downloadAndInstall()
  } catch (err) {
    deps.notify.error('Update failed', {
      body: err instanceof Error ? err.message : String(err),
      source: 'updater',
    })
    return 'failed'
  }

  try {
    await deps.relaunch()
  } catch (err) {
    // The update is on disk and will apply next launch, so this is not the
    // failure it looks like — say so rather than implying the update was lost.
    deps.notify.warning('Update installed — restart to finish', {
      body: err instanceof Error ? err.message : String(err),
      source: 'updater',
    })
  }
  return 'installing'
}
