import { defineStore } from 'pinia'
import type { EditorSettings } from '@/cm/setup'
import { loadValue, removeValue, saveValue } from '@/services/store'
import { normalizeRoot } from '@/services/paths'
import { useSessionStore } from './session'
import { useGitStore } from './git'

/** A saved workspace: a server plus one or more root directories, with a pretty
 *  name and optional per-project editor overrides. */
export interface Project {
  id: string
  name: string
  controlPlane: string | null
  clientId: string
  /** The workspace's root directories (multi-root). */
  rootPaths: string[]
  /** @deprecated migrated to rootPaths on load. */
  rootPath?: string
  editor?: Partial<EditorSettings>
  createdAt: number
}

/** Persisted UI state for the Project explorer — which project is open and which
 *  are expanded. Kept separate from the projects array (different lifecycle) and
 *  holds only ids, never any server-side content. */
interface ProjectsUi {
  activeId: string | null
  expandedIds: string[]
}
const UI_KEY = 'projects-ui'

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [] as Project[],
    activeId: null as string | null,
    /** Project ids whose root list is expanded in the explorer. */
    expandedIds: new Set<string>(),
    loaded: false,
  }),

  getters: {
    active(state): Project | null {
      return state.projects.find((p) => p.id === state.activeId) ?? null
    },
    /** Primary root of the active project (first root), or null. */
    primaryRoot(): string | null {
      return this.active?.rootPaths[0] ?? null
    },
  },

  actions: {
    async load() {
      const raw = await loadValue<Project[]>('projects', [])
      // Migrate single-root projects (rootPath) to multi-root (rootPaths).
      this.projects = raw.map((p) => ({
        ...p,
        rootPaths: p.rootPaths?.length ? p.rootPaths.map(normalizeRoot) : [normalizeRoot(p.rootPath ?? '/')],
      }))
      // Restore which project was open / expanded, dropping any since deleted.
      const ui = await loadValue<ProjectsUi>(UI_KEY, { activeId: null, expandedIds: [] })
      const exists = new Set(this.projects.map((p) => p.id))
      this.activeId = ui.activeId && exists.has(ui.activeId) ? ui.activeId : null
      this.expandedIds = new Set((ui.expandedIds ?? []).filter((id) => exists.has(id)))
      this.loaded = true
      // 'workspaces' predates 'projects' and nothing has read it in a long time;
      // leaving it in the file just invites the question of which one is real.
      void removeValue('workspaces')
    },

    /** Point a project at a different server. Its roots are paths, not handles,
     *  so they carry over untouched — this exists because an agent's clientId
     *  can change (renamed, reinstalled, re-cased) and a saved project is then
     *  addressing a machine the control plane has never heard of. */
    async moveToServer(id: string, clientId: string) {
      const project = this.projects.find((p) => p.id === id)
      if (!project || !clientId || project.clientId === clientId) return
      project.clientId = clientId
      await this.persist()
      if (this.activeId === id) useSessionStore().selectAgent(clientId)
    },

    async persist() {
      await saveValue('projects', this.projects)
    },

    persistUi() {
      void saveValue<ProjectsUi>(UI_KEY, {
        activeId: this.activeId,
        expandedIds: [...this.expandedIds],
      })
    },

    /** Expand/collapse a project's root list in the explorer (persisted). */
    setExpanded(id: string, expanded: boolean) {
      if (expanded) this.expandedIds.add(id)
      else this.expandedIds.delete(id)
      this.persistUi()
    },

    async create(input: {
      name: string
      controlPlane: string | null
      clientId: string
      rootPaths: string[]
    }): Promise<Project> {
      const project: Project = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        ...input,
        rootPaths: input.rootPaths.map(normalizeRoot),
      }
      this.projects.push(project)
      await this.persist()
      return project
    },

    async remove(id: string) {
      this.projects = this.projects.filter((p) => p.id !== id)
      if (this.activeId === id) this.activeId = null
      this.expandedIds.delete(id)
      this.persistUi()
      await this.persist()
    },

    async rename(id: string, name: string) {
      const project = this.projects.find((p) => p.id === id)
      const trimmed = name.trim()
      if (!project || !trimmed || project.name === trimmed) return
      project.name = trimmed
      await this.persist()
    },

    /** Append a root directory to a project. Returns the normalized root (also
     *  when it was already present) so callers can expand exactly that key. */
    async addRoot(id: string, path: string): Promise<string | null> {
      const project = this.projects.find((p) => p.id === id)
      const root = normalizeRoot(path)
      if (!project || !root) return null
      if (project.rootPaths.includes(root)) return root
      project.rootPaths.push(root)
      await this.persist()
      return root
    },

    /** Remove a root directory from a project (does not delete files). */
    async removeRoot(id: string, path: string) {
      const project = this.projects.find((p) => p.id === id)
      const root = normalizeRoot(path)
      if (!project) return
      project.rootPaths = project.rootPaths.filter((r) => r !== root)
      await this.persist()
    },

    /** Make a project active and select its server. */
    open(id: string) {
      const project = this.projects.find((p) => p.id === id)
      if (!project) return
      this.activeId = id
      // Remember the open project so a refresh can reopen it once its server is back.
      this.persistUi()
      const session = useSessionStore()
      // The File explorer browse root is independent; just select the server.
      session.selectAgent(project.clientId)
      const primary = project.rootPaths[0]
      if (primary) void useGitStore().refresh(project.clientId, primary)
    },
  },
})
