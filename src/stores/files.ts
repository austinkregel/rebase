import { defineStore } from 'pinia'
import { fileService } from '@/services/fileService'
import { AgentOfflineError, useAgentsStore } from '@/stores/agents'
import { useGitStore } from '@/stores/git'
import { useProjectsStore } from '@/stores/projects'
import { baseName, isWindowsPath, normalizeRoot, parentDir } from '@/services/paths'
import { resolveOpen, type FileContentKind, type FileSpecial } from '@/services/fileContent'
import { loadValue, saveValue } from '@/services/store'
import type { DirListEntry } from '@/transport/types'

// Which directories are expanded, persisted per server. We save only the *set of
// open paths* (never the listings themselves) so a refresh can restore the tree
// shape and re-fetch fresh contents — keeping us safe if the server's filesystem
// changed since last visit.
const EXPANDED_KEY = 'tree-expanded'

/** Persisted shape of the expanded map: clientId → expanded paths. */
type ExpandedByClient = Record<string, string[]>

/**
 * Composite identity for an open file: a *server's* file, not just a path. The
 * Project explorer shows roots from several servers at once, so the same
 * absolute path can be open on two agents — keying by path alone collides
 * (opening /etc/hosts on B would surface A's buffer). This string is also the
 * Dockview panel id, so `activeKey` and a panel id are interchangeable.
 */
export function fileKey(clientId: string, path: string): string {
  return `${clientId}\0${path}`
}

/** Inverse of {@link fileKey}. A key without a separator is treated as path-only. */
export function parseFileKey(key: string): { clientId: string; path: string } {
  const i = key.indexOf('\0')
  return i === -1 ? { clientId: '', path: key } : { clientId: key.slice(0, i), path: key.slice(i + 1) }
}

/** Directory separator matching a path's OS style. */
function sepFor(path: string): string {
  return isWindowsPath(path) ? '\\' : '/'
}

/** True when `path` is `dir` itself or lives beneath it. */
function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sepFor(dir))
}

/** Re-root a path from under `oldDir` to under `newDir` (dir move/rename). */
function reparent(path: string, oldDir: string, newDir: string): string {
  return newDir + path.slice(oldDir.length)
}

export interface OpenFile {
  path: string
  clientId: string
  /** Buffer as the editor sees it. */
  content: string
  /** Content as last loaded/saved — dirty when it differs. */
  savedContent: string
  loading: boolean
  error: string | null
  /** How the file is opened (editor / viewer / hex / preview) — see fileContent. */
  kind: FileContentKind
  /** True only for clean, losslessly-UTF-8 text within the editable size cap. */
  editable: boolean
  /** Preview is shorter than the whole file (oversized/paged). */
  truncated: boolean
  size: number
  mode?: string
  special?: FileSpecial
  /** Banner text explaining a read-only / not-shown state. */
  reason?: string
  /** Id of the content-aware viewer rendering this file (undefined → editor). */
  viewerId?: string
  /** Mirror of `!editable`. */
  readOnly?: boolean
}

export const useFilesStore = defineStore('files', {
  state: () => ({
    /** Directory listings keyed by clientId → path. Every agent gets its own
     *  namespace: the Project explorer shows roots from several servers at once,
     *  so a single flat map would blank out every project but the active one. */
    tree: {} as Record<string, Record<string, DirListEntry[]>>,
    /** Expanded directory paths, keyed by clientId (persisted as arrays). */
    expanded: {} as Record<string, Set<string>>,
    openFiles: [] as OpenFile[],
    /** The active open file, identified by fileKey(clientId, path) — see fileKey. */
    activeKey: null as string | null,
    /** The File explorer's current root — a single, ad-hoc browse location
     *  (not persisted; the persisted multi-root workspace lives on projects). */
    browseRoot: '/',
  }),

  getters: {
    activeFile(state): OpenFile | null {
      return state.openFiles.find((f) => fileKey(f.clientId, f.path) === state.activeKey) ?? null
    },
    isDirty: () => (file: OpenFile) => file.content !== file.savedContent,
    dirtyCount(state): number {
      return state.openFiles.filter((f) => f.content !== f.savedContent).length
    },
    /** Alias for the File explorer root, kept for callers that want "a root". */
    rootPath(state): string {
      return state.browseRoot
    },
    /** Listing for a directory on a given agent, or undefined if not loaded. */
    entriesFor(state) {
      return (clientId: string | null, path: string): DirListEntry[] | undefined =>
        clientId ? state.tree[clientId]?.[path] : undefined
    },
    /** Whether a directory is expanded on a given agent. */
    isExpanded(state) {
      return (clientId: string | null, path: string): boolean =>
        !!clientId && !!state.expanded[clientId]?.has(path)
    },
    /** Whether a given agent's file is open. */
    isOpen(state) {
      return (clientId: string, path: string): boolean =>
        state.openFiles.some((f) => f.clientId === clientId && f.path === path)
    },
    /** Whether a given agent's file is the active one. */
    isActive(state) {
      return (clientId: string, path: string): boolean =>
        state.activeKey === fileKey(clientId, path)
    },
  },

  actions: {
    /** Drop every cached listing and buffer (the socket dropped — nothing we
     *  hold is known-good any more). The expanded *shape* is kept: it is the
     *  persisted state, and restore() re-fetches its listings on reconnect.
     *  browseRoot is set afterward by session.selectAgent(). */
    reset() {
      this.tree = {}
      this.openFiles = []
      this.activeKey = null
    },

    /** Close every buffer, keeping cached listings — used when switching agents,
     *  where other servers' trees must survive for the Project explorer. */
    closeAllFiles() {
      this.openFiles = []
      this.activeKey = null
    },

    /** The (created-on-demand) expanded set for an agent. */
    expandedSet(clientId: string): Set<string> {
      return (this.expanded[clientId] ??= new Set())
    },

    /** Point the File explorer at a directory. */
    setBrowseRoot(path: string) {
      this.browseRoot = normalizeRoot(path)
    },

    /** Hydrate the persisted expanded-directory map (call once at startup). */
    async loadExpanded() {
      const stored = await loadValue<ExpandedByClient>(EXPANDED_KEY, {})
      this.expanded = Object.fromEntries(
        Object.entries(stored).map(([clientId, paths]) => [clientId, new Set(paths)]),
      )
    },

    /** Persist the expanded sets of every server. */
    persistExpanded() {
      const snapshot: ExpandedByClient = {}
      for (const [clientId, paths] of Object.entries(this.expanded)) snapshot[clientId] = [...paths]
      void saveValue(EXPANDED_KEY, snapshot)
    },

    /** Restore a server's expanded directories and re-fetch their listings.
     *  Listings are intentionally re-read (never persisted) so a changed remote
     *  filesystem can't show stale entries. Paths that no longer list are dropped. */
    async restore(clientId: string) {
      const expanded = this.expandedSet(clientId)
      // A failed listing below prunes the path from the persisted shape. That is
      // right for a directory that no longer exists and wrong for every path on
      // a server that merely happens to be down, so don't even start.
      if (!useAgentsStore().isOnline(clientId)) return
      await Promise.all(
        [...expanded].map(async (path) => {
          try {
            await this.loadDir(clientId, path)
          } catch {
            expanded.delete(path)
          }
        }),
      )
      this.persistExpanded()
    },

    async loadDir(clientId: string, path: string) {
      const agents = useAgentsStore()
      // Precondition, not a connection step: there is one socket to the control
      // plane and an agent is just a `clientId` in the payload. Nothing needs
      // "opening" — but addressing a server the CP hasn't listed buys a silent
      // 20s timeout, so refuse up front with a message that names the server.
      if (!agents.isOnline(clientId)) {
        throw new AgentOfflineError(clientId, agents.displayName(clientId))
      }
      const entries = await fileService.list(clientId, path)
      // The socket may have dropped (and reset() wiped the tree) while we awaited;
      // writing now would repopulate a now-unreachable server's tree with a stale
      // listing. Bail if the agent went offline mid-list.
      if (!agents.isOnline(clientId)) return
      // Directories first, then files, both alphabetical.
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      )
      ;(this.tree[clientId] ??= {})[path] = entries
    },

    /** Load a directory unless its listing is already cached. */
    async ensureDir(clientId: string, path: string) {
      if (!this.tree[clientId]?.[path]) await this.loadDir(clientId, path)
    },

    /** Expand a directory (loading it if needed); no-op when already expanded
     *  *and* loaded, which is what makes a re-expand after a wiped cache work. */
    async expand(clientId: string, path: string) {
      const expanded = this.expandedSet(clientId)
      const wasExpanded = expanded.has(path)
      expanded.add(path)
      try {
        await this.ensureDir(clientId, path)
      } catch (err) {
        if (!wasExpanded) expanded.delete(path)
        throw err
      } finally {
        this.persistExpanded()
      }
    },

    /** Collapse a directory. Its listing stays cached for the next expand. */
    collapse(clientId: string, path: string) {
      if (this.expandedSet(clientId).delete(path)) this.persistExpanded()
    },

    async toggleDir(clientId: string, path: string) {
      if (this.expandedSet(clientId).has(path)) {
        this.collapse(clientId, path)
        return
      }
      await this.expand(clientId, path)
    },

    async openFile(clientId: string, path: string) {
      const existing = this.openFiles.find((f) => f.clientId === clientId && f.path === path)
      if (existing) {
        this.activeKey = fileKey(clientId, path)
        return
      }
      // Placeholder buffer; fileContent.resolveOpen classifies the file (from
      // metadata + a content sniff, never the extension alone) and returns text
      // only for clean, editable text. Binary/unknown content stays read-only
      // (empty buffer) so a save can't corrupt it.
      const file: OpenFile = {
        path,
        clientId,
        content: '',
        savedContent: '',
        loading: true,
        error: null,
        kind: 'text',
        editable: false,
        truncated: false,
        size: -1,
      }
      this.openFiles.push(file)
      // Mutate the reactive proxy stored in the array, NOT the local `file`
      // literal — writes to the raw object don't trigger reactivity, so the
      // editor would never see `loading` flip to false (stuck "loading…").
      const entry = this.openFiles[this.openFiles.length - 1]
      this.activeKey = fileKey(clientId, path)
      try {
        const known = this.entriesFor(clientId, parentDir(path))?.find((e) => e.name === baseName(path))
        const { plan, content } = await resolveOpen(clientId, path, known)
        entry.kind = plan.kind
        entry.editable = plan.editable
        entry.readOnly = plan.editable ? undefined : true
        entry.truncated = plan.truncated
        entry.size = plan.size
        entry.mode = plan.mode
        entry.special = plan.special
        entry.reason = plan.reason
        entry.viewerId = plan.viewerId
        if (content != null) {
          entry.content = content
          entry.savedContent = content
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err)
      } finally {
        entry.loading = false
      }
    },

    updateContent(clientId: string, path: string, content: string) {
      const file = this.openFiles.find((f) => f.clientId === clientId && f.path === path)
      if (file) file.content = content
    },

    /** Re-read an already-open file's content (used by the editor's Retry),
     *  re-classifying in case the file changed type/size. */
    async reloadFile(clientId: string, path: string) {
      const file = this.openFiles.find((f) => f.clientId === clientId && f.path === path)
      if (!file) return
      file.loading = true
      file.error = null
      try {
        const { plan, content } = await resolveOpen(clientId, path)
        file.kind = plan.kind
        file.editable = plan.editable
        file.readOnly = plan.editable ? undefined : true
        file.truncated = plan.truncated
        file.size = plan.size
        file.reason = plan.reason
        file.viewerId = plan.viewerId
        file.content = content ?? ''
        file.savedContent = content ?? ''
      } catch (err) {
        file.error = err instanceof Error ? err.message : String(err)
      } finally {
        file.loading = false
      }
    },

    async saveFile(clientId: string, path: string) {
      const file = this.openFiles.find((f) => f.clientId === clientId && f.path === path)
      // Only clean, editable text may be written back. Loading/errored buffers
      // would clobber the file with a partial/empty write; binary, hex, oversized,
      // and viewer buffers are read-only (editable === false).
      if (!file || file.loading || file.error || !file.editable) return
      const snapshot = file.content
      await fileService.write(file.clientId, file.path, snapshot)
      file.savedContent = snapshot
      // A save may change the repo's dirty count; refresh git for the active
      // project's primary root (on the same server), else the browse root.
      const projects = useProjectsStore()
      const projectRoot =
        projects.active?.clientId === file.clientId ? projects.active?.rootPaths[0] : undefined
      void useGitStore().refresh(file.clientId, projectRoot ?? this.browseRoot)
    },

    /** Create a directory then refresh the listing it lives in. */
    async createDirectory(clientId: string, path: string, reloadDir: string) {
      await fileService.mkdir(clientId, path)
      await this.loadDir(clientId, reloadDir)
    },

    /** Create an empty file, refresh its directory, and open it. */
    async createFile(clientId: string, path: string, reloadDir: string) {
      await fileService.write(clientId, path, '')
      await this.loadDir(clientId, reloadDir)
      await this.openFile(clientId, path)
    },

    /** Rename/move an entry, fix any open buffers (including those beneath a
     *  renamed directory), and refresh affected dirs. */
    async renameEntry(clientId: string, oldPath: string, newPath: string, reloadDirs: string[]) {
      await fileService.rename(clientId, oldPath, newPath)
      // Remap the entry itself and every open buffer under it (dir rename).
      for (const f of this.openFiles) {
        if (f.clientId === clientId && isUnder(f.path, oldPath)) {
          const from = f.path
          f.path = reparent(f.path, oldPath, newPath)
          if (this.activeKey === fileKey(clientId, from)) {
            this.activeKey = fileKey(clientId, f.path)
          }
        }
      }
      // Remap expanded dirs at/under oldPath so children aren't orphaned.
      const expanded = this.expandedSet(clientId)
      let changed = false
      for (const p of [...expanded]) {
        if (isUnder(p, oldPath)) {
          expanded.delete(p)
          expanded.add(reparent(p, oldPath, newPath))
          changed = true
        }
      }
      if (changed) this.persistExpanded()
      for (const dir of new Set(reloadDirs)) await this.loadDir(clientId, dir)
    },

    /** Delete an entry, close it and anything open beneath it, collapse its
     *  descendants, and refresh its parent listing. */
    async removeEntry(clientId: string, path: string, recursive: boolean, reloadDir: string) {
      await fileService.delete(clientId, path, recursive)
      for (const f of [...this.openFiles]) {
        if (f.clientId === clientId && isUnder(f.path, path)) this.closeFile(clientId, f.path)
      }
      const expanded = this.expandedSet(clientId)
      let changed = false
      for (const p of [...expanded]) {
        if (isUnder(p, path)) {
          expanded.delete(p)
          changed = true
        }
      }
      if (changed) this.persistExpanded()
      await this.loadDir(clientId, reloadDir)
    },

    closeFile(clientId: string, path: string) {
      const index = this.openFiles.findIndex((f) => f.clientId === clientId && f.path === path)
      if (index === -1) return
      this.openFiles.splice(index, 1)
      if (this.activeKey === fileKey(clientId, path)) {
        const next = this.openFiles[Math.min(index, this.openFiles.length - 1)]
        this.activeKey = next ? fileKey(next.clientId, next.path) : null
      }
    },
  },
})
