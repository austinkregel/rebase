import { markRaw, reactive, type Component, type FunctionalComponent } from 'vue'

/**
 * Status-bar contribution registry. Plugins (and core, dogfooding) register
 * items into the left/right groups of the StatusTray. Simple items are an
 * icon/text that runs a command or onClick; `component` lets an item render
 * arbitrary UI (e.g. the notifications popover).
 */
export interface StatusItem {
  id: string
  side: 'left' | 'right'
  /** Lower sorts first within its side. */
  order?: number
  when?: () => boolean
  // --- simple item ---
  text?: () => string
  icon?: FunctionalComponent
  tone?: 'default' | 'accent' | 'warn' | 'danger'
  tooltip?: string
  /** Command id to run on click. */
  command?: string
  onClick?: () => void
  /** Custom renderer; takes precedence over the simple fields above. */
  component?: Component
}

const registry = reactive(new Map<string, StatusItem>())

export function registerStatusItem(item: StatusItem): () => void {
  const raw = markRaw(item)
  registry.set(raw.id, raw)
  return () => {
    if (registry.get(raw.id) === raw) registry.delete(raw.id)
  }
}

/** Items for a side, visible (`when`) and sorted by `order` then id. */
export function statusItems(side: 'left' | 'right'): StatusItem[] {
  return [...registry.values()]
    .filter((i) => i.side === side && (!i.when || i.when()))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
}
