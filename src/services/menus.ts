import { markRaw, reactive } from 'vue'
import type { ContextMenuItem } from './contextMenu'

/**
 * Context-menu contribution registry. Each call site (file/folder tree, project
 * rows, server list, editor tab) builds its core items, then appends
 * `menuItemsFor(menu, ctx)` so plugins (and core, dogfooding) can contribute.
 * The `ctx` is the typed payload available at that location.
 */
export type MenuId =
  | 'file/context'
  | 'folder/context'
  | 'project/context'
  | 'projectRoot/context'
  | 'server/context'
  | 'editorTab/context'
  | 'terminal/context'

export interface FileMenuContext {
  clientId: string
  path: string
  name: string
  isDir: boolean
}
export interface ProjectMenuContext {
  projectId: string
  name: string
  clientId: string
  rootPaths: string[]
}
export interface ProjectRootMenuContext {
  projectId: string
  clientId: string
  root: string
}
export interface ServerMenuContext {
  clientId: string
  hostname?: string
  platform?: string
}
export interface EditorTabMenuContext {
  clientId?: string
  path?: string
}
export interface TerminalMenuContext {
  clientId: string
  sessionId?: string
}

export interface MenuContribution<C = unknown> {
  id: string
  menu: MenuId
  order?: number
  when?: (ctx: C) => boolean
  build: (ctx: C) => ContextMenuItem | ContextMenuItem[]
}

const registry = reactive(new Map<string, MenuContribution>())

export function registerMenuItem<C>(c: MenuContribution<C>): () => void {
  const raw = markRaw(c as MenuContribution)
  registry.set(raw.id, raw)
  return () => {
    if (registry.get(raw.id) === raw) registry.delete(raw.id)
  }
}

/** Contributed items for a menu location given its context, sorted by `order`. */
export function menuItemsFor<C>(menu: MenuId, ctx: C): ContextMenuItem[] {
  return [...registry.values()]
    .filter((c) => c.menu === menu && (!c.when || c.when(ctx)))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    .flatMap((c) => {
      const built = c.build(ctx)
      return Array.isArray(built) ? built : [built]
    })
}
