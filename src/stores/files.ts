import { defineStore } from 'pinia'
import { fileService } from '@/services/fileService'
import { useGitStore } from '@/stores/git'
import { useProjectsStore } from '@/stores/projects'
import { normalizeRoot } from '@/services/paths'
import type { DirListEntry } from '@/transport/types'

export interface OpenFile {
  path: string
  clientId: string
  /** Buffer as the editor sees it. */
  content: string
  /** Content as last loaded/saved — dirty when it differs. */
  savedContent: string
  loading: boolean
  error: string | null
}

export const useFilesStore = defineStore('files', {
  state: () => ({
    /** Directory listings keyed by path, for the active agent. */
    tree: {} as Record<string, DirListEntry[]>,
    expanded: new Set<string>(),
    openFiles: [] as OpenFile[],
    activePath: null as string | null,
    /** The File explorer's current root — a single, ad-hoc browse location
     *  (not persisted; the persisted multi-root workspace lives on projects). */
    browseRoot: '/',
  }),

  getters: {
    activeFile(state): OpenFile | null {
      return state.openFiles.find((f) => f.path === state.activePath) ?? null
    },
    isDirty: () => (file: OpenFile) => file.content !== file.savedContent,
    dirtyCount(state): number {
      return state.openFiles.filter((f) => f.content !== f.savedContent).length
    },
    /** Alias for the File explorer root, kept for callers that want "a root". */
    rootPath(state): string {
      return state.browseRoot
    },
  },

  actions: {
    /** Drop all agent-specific state (when switching machines). browseRoot is set
     *  afterward by session.selectAgent(). */
    reset() {
      this.tree = {}
      this.expanded = new Set()
      this.openFiles = []
      this.activePath = null
    },

    /** Point the File explorer at a directory. */
    setBrowseRoot(path: string) {
      this.browseRoot = normalizeRoot(path)
    },

    async loadDir(clientId: string, path: string) {
      const entries = await fileService.list(clientId, path)
      // Directories first, then files, both alphabetical.
      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      )
      this.tree[path] = entries
    },

    async toggleDir(clientId: string, path: string) {
      if (this.expanded.has(path)) {
        this.expanded.delete(path)
        return
      }
      this.expanded.add(path)
      if (!this.tree[path]) {
        try {
          await this.loadDir(clientId, path)
        } catch (err) {
          this.expanded.delete(path)
          throw err
        }
      }
    },

    async openFile(clientId: string, path: string) {
      const existing = this.openFiles.find((f) => f.path === path)
      if (existing) {
        this.activePath = path
        return
      }
      const file: OpenFile = {
        path,
        clientId,
        content: '',
        savedContent: '',
        loading: true,
        error: null,
      }
      this.openFiles.push(file)
      this.activePath = path
      try {
        const content = await fileService.read(clientId, path)
        file.content = content
        file.savedContent = content
      } catch (err) {
        file.error = err instanceof Error ? err.message : String(err)
      } finally {
        file.loading = false
      }
    },

    updateContent(path: string, content: string) {
      const file = this.openFiles.find((f) => f.path === path)
      if (file) file.content = content
    },

    /** Re-read an already-open file's content (used by the editor's Retry). */
    async reloadFile(path: string) {
      const file = this.openFiles.find((f) => f.path === path)
      if (!file) return
      file.loading = true
      file.error = null
      try {
        const content = await fileService.read(file.clientId, path)
        file.content = content
        file.savedContent = content
      } catch (err) {
        file.error = err instanceof Error ? err.message : String(err)
      } finally {
        file.loading = false
      }
    },

    async saveFile(path: string) {
      const file = this.openFiles.find((f) => f.path === path)
      // Never save while loading or when the content failed to load — that would
      // clobber the file with an empty/partial buffer.
      if (!file || file.loading || file.error) return
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

    /** Rename/move an entry, fix any open buffers, and refresh affected dirs. */
    async renameEntry(clientId: string, oldPath: string, newPath: string, reloadDirs: string[]) {
      await fileService.rename(clientId, oldPath, newPath)
      for (const f of this.openFiles) {
        if (f.path === oldPath) f.path = newPath
      }
      if (this.activePath === oldPath) this.activePath = newPath
      if (this.expanded.has(oldPath)) {
        this.expanded.delete(oldPath)
        this.expanded.add(newPath)
      }
      for (const dir of new Set(reloadDirs)) await this.loadDir(clientId, dir)
    },

    /** Delete an entry, close it if open, and refresh its parent listing. */
    async removeEntry(clientId: string, path: string, recursive: boolean, reloadDir: string) {
      await fileService.delete(clientId, path, recursive)
      this.closeFile(path)
      this.expanded.delete(path)
      await this.loadDir(clientId, reloadDir)
    },

    closeFile(path: string) {
      const index = this.openFiles.findIndex((f) => f.path === path)
      if (index === -1) return
      this.openFiles.splice(index, 1)
      if (this.activePath === path) {
        this.activePath = this.openFiles[Math.min(index, this.openFiles.length - 1)]?.path ?? null
      }
    },
  },
})
