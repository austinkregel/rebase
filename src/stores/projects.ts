import { defineStore } from 'pinia'
import type { EditorSettings } from '@/cm/setup'
import { loadValue, saveValue } from '@/services/store'
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

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [] as Project[],
    activeId: null as string | null,
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
      this.loaded = true
    },

    async persist() {
      await saveValue('projects', this.projects)
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
      await this.persist()
    },

    async rename(id: string, name: string) {
      const project = this.projects.find((p) => p.id === id)
      const trimmed = name.trim()
      if (!project || !trimmed || project.name === trimmed) return
      project.name = trimmed
      await this.persist()
    },

    /** Append a root directory to a project. */
    async addRoot(id: string, path: string) {
      const project = this.projects.find((p) => p.id === id)
      const root = normalizeRoot(path)
      if (!project || !root || project.rootPaths.includes(root)) return
      project.rootPaths.push(root)
      await this.persist()
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
      const session = useSessionStore()
      // The File explorer browse root is independent; just select the server.
      session.selectAgent(project.clientId)
      const primary = project.rootPaths[0]
      if (primary) void useGitStore().refresh(project.clientId, primary)
    },
  },
})
