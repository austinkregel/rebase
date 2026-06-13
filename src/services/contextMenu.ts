import { reactive } from 'vue'

/**
 * A single floating context menu shared across the app. Any component can call
 * `contextMenu.open(event, items)`; one <ContextMenu> instance (mounted in the
 * files panel) renders it at the pointer and dismisses on outside-click/Esc.
 * Modeled on the lightweight reactive-singleton pattern used by services/dock.ts.
 */
export interface ContextMenuItem {
  label: string
  /** Run when chosen. The menu closes first, then this is invoked. */
  action?: () => void
  /** Render in the destructive accent (delete, remove). */
  danger?: boolean
  /** Disable the item (shown greyed, not clickable). */
  disabled?: boolean
  /** Insert a divider above this item. */
  separator?: boolean
}

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}

export const contextMenu = reactive<ContextMenuState>({
  open: false,
  x: 0,
  y: 0,
  items: [],
})

/** Open the menu at a pointer event with a context-specific item list. */
export function openContextMenu(event: MouseEvent, items: ContextMenuItem[]) {
  event.preventDefault()
  event.stopPropagation()
  contextMenu.x = event.clientX
  contextMenu.y = event.clientY
  contextMenu.items = items
  contextMenu.open = true
}

export function closeContextMenu() {
  contextMenu.open = false
  contextMenu.items = []
}
