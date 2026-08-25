import { defineStore } from 'pinia'
import type { EditorSettings } from '@/cm/setup'
import { loadValue, removeValue, saveValue } from '@/services/store'
import { normalizeRoot } from '@/services/paths'
import { shell } from '@/services/shell'
import { useSessionStore } from './session'
import { useGitStore } from './git'

/** The column-2 view id of the Project (IDE) focus tab, contributed by the
 *  projects plugin. `enterProjectMode` asks the shell to select it. */
export const PROJECT_FOCUS_VIEW = 'project-focus'

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
  /** Which project the IDE (focus) mode is scoped to, if any. */
  focusedId: string | null
}
const UI_KEY = 'projects-ui'

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [] as Project[],
    activeId: null as string | null,
    /** Non-null means we are in project (IDE) mode, scoped to this project. Kept
     *  separate from `activeId`: opening a project for a look sets `activeId`;
     *  committing to the IDE mode sets `focusedId`. */
    focusedId: null as string | null,
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
    /** The project the IDE mode is scoped to, or null. */
    focused(state): Project | null {
      return state.projects.find((p) => p.id === state.focusedId) ?? null
    },
    /** Whether project (IDE) mode is active. */
    inProjectMode(state): boolean {
      return state.focusedId !== null
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
      // Restore which project was open / focused / expanded, dropping any since deleted.
      const ui = await loadValue<ProjectsUi>(UI_KEY, { activeId: null, expandedIds: [], focusedId: null })
      const exists = new Set(this.projects.map((p) => p.id))
      this.activeId = ui.activeId && exists.has(ui.activeId) ? ui.activeId : null
      this.focusedId = ui.focusedId && exists.has(ui.focusedId) ? ui.focusedId : null
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
        focusedId: this.focusedId,
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
      // A deleted project can't be the one we're focused on — drop the mode.
      if (this.focusedId === id) this.focusedId = null
      this.expandedIds.delete(id)
      this.persistUi()
      // Drop the project's saved editor layout (keyed by id in Workbench.vue's
      // `layoutKey`), so a deleted project doesn't leave an orphan behind.
      void removeValue(`editor.v2:${id}`)
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

    /** Enter project (IDE) mode: open the project — which selects its server,
     *  persists UI state, and refreshes git — then focus the shell on it and
     *  select the Project tab. `open()` and entering are distinct acts (see
     *  `focusedId`), but entering always implies opening. */
    enterProjectMode(id: string) {
      const project = this.projects.find((p) => p.id === id)
      if (!project) return
      this.open(id)
      this.focusedId = id
      this.persistUi()
      shell.focusProjectTab?.(PROJECT_FOCUS_VIEW)
    },

    /** Leave project mode. `activeId` survives — the project stays open for a
     *  look, the shell just stops being scoped to it. */
    exitProjectMode() {
      if (this.focusedId === null) return
      this.focusedId = null
      this.persistUi()
    },

    /** Toggle project mode. With no id: exit if focused, else enter the active
     *  (or previously focused) project. With an id: exit if it's already the
     *  focused one, else enter it. */
    toggleProjectMode(id?: string) {
      if (this.focusedId && (!id || id === this.focusedId)) {
        this.exitProjectMode()
        return
      }
      const target = id ?? this.activeId ?? this.focusedId
      if (target) this.enterProjectMode(target)
    },
  },
})
