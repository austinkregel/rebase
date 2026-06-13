import { markRaw, reactive } from 'vue'

/**
 * A VS Code-style command registry. Areas of the app contribute commands
 * (with disposal), the command palette lists them, and the keybinding layer
 * dispatches to them by id. Keeps UI actions discoverable and scriptable from
 * one place.
 */
export interface Command {
  id: string
  title: string
  /** Grouping label shown in the palette, e.g. "File", "View", "Workspace". */
  category?: string
  /** Display-only keybinding hint (e.g. "⌘⇧P"); the actual binding lives in keybindings.ts. */
  keybinding?: string
  run: () => void | Promise<void>
  /** When present and false, the command is hidden/disabled. */
  isEnabled?: () => boolean
}

// A reactive map so the palette's command list updates as areas mount/unmount.
const registry = reactive(new Map<string, Command>())

/** Register one command; returns a disposer. */
export function registerCommand(cmd: Command): () => void {
  // markRaw so the reactive Map stores the command by identity (its values are
  // static); only the set of commands needs to be reactive, not their fields.
  const raw = markRaw(cmd)
  registry.set(raw.id, raw)
  return () => {
    if (registry.get(raw.id) === raw) registry.delete(raw.id)
  }
}

/** Register several commands; returns a single disposer for all of them. */
export function registerCommands(cmds: Command[]): () => void {
  const disposers = cmds.map(registerCommand)
  return () => disposers.forEach((d) => d())
}

export function allCommands(): Command[] {
  return [...registry.values()]
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id)
}

export async function runCommand(id: string): Promise<void> {
  const cmd = registry.get(id)
  if (!cmd) return
  if (cmd.isEnabled && !cmd.isEnabled()) return
  await cmd.run()
}

// --- Command palette open state (one palette, mounted in App.vue) ---
export const palette = reactive({ open: false })

export function openPalette() {
  palette.open = true
}
export function closePalette() {
  palette.open = false
}
export function togglePalette() {
  palette.open = !palette.open
}
