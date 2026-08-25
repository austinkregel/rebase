import { markRaw, reactive, type Component, type FunctionalComponent } from 'vue'

/**
 * View contribution registry — lets a plugin contribute a tab/panel to a
 * sidebar location (column-2 Project area, or the Tools column). The Projects
 * panel and Code Search become contributed views rather than hardcoded tabs.
 */
export type ViewLocation = 'sidebar.project' | 'sidebar.tools'

export interface ViewContribution {
  id: string
  location: ViewLocation
  title: string
  icon: FunctionalComponent
  /** Optional filled/active icon (the project column uses outline→solid). */
  iconActive?: FunctionalComponent
  order?: number
  /** Optional visibility predicate — a tab present only in some app state (e.g.
   *  the Project focus tab, shown only in project mode). Evaluated by consumers
   *  inside a computed, so it must read reactive state to update live. */
  visible?: () => boolean
  component: Component
}

const registry = reactive(new Map<string, ViewContribution>())

export function registerView(v: ViewContribution): () => void {
  const raw = markRaw(v)
  registry.set(raw.id, raw)
  return () => {
    if (registry.get(raw.id) === raw) registry.delete(raw.id)
  }
}

export function viewsFor(location: ViewLocation): ViewContribution[] {
  return [...registry.values()]
    .filter((v) => v.location === location)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
}
