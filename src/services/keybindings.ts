import { reactive } from 'vue'
import { runCommand, togglePalette } from './commands'

/**
 * App-level keybindings (VS Code defaults), platform-aware. The editor's own
 * keybindings live in the CodeMirror keymap; this layer handles workbench
 * commands (palette, toggles, editor lifecycle) globally. Plugins contribute
 * their own chords via registerKeybinding (e.g. the terminal plugin's Ctrl+`).
 */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export interface Binding {
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean
  /** Literal Ctrl on every platform (VS Code uses this for the terminal). */
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  key: string
  /** Command id to run, or the special "__palette" toggle. */
  command: string
  /** "skip" → don't handle while a CodeMirror editor is focused (CM owns it). */
  whenEditor?: 'skip'
}

// Core chords (workbench commands). Plugin chords live in `registered`.
const coreBindings: Binding[] = [
  { mod: true, shift: true, key: 'p', command: '__palette' },
  { mod: true, key: 'b', command: 'view.toggleServers' },
  { mod: true, key: 'j', command: 'view.toggleTools' },
  { mod: true, key: 'w', command: 'editor.closeActive', whenEditor: 'skip' },
  { mod: true, key: 's', command: 'file.saveActive', whenEditor: 'skip' },
]
const registered = reactive(new Set<Binding>())

/** Register a keybinding (used by plugins); returns a disposer. */
export function registerKeybinding(b: Binding): () => void {
  registered.add(b)
  return () => registered.delete(b)
}

function allBindings(): Binding[] {
  return [...coreBindings, ...registered]
}

function matches(b: Binding, e: KeyboardEvent): boolean {
  const expectedMeta = !!b.mod && isMac
  const expectedCtrl = (!!b.mod && !isMac) || !!b.ctrl
  return (
    e.metaKey === expectedMeta &&
    e.ctrlKey === expectedCtrl &&
    e.shiftKey === !!b.shift &&
    e.altKey === !!b.alt &&
    e.key.toLowerCase() === b.key.toLowerCase()
  )
}

export function handleKeydown(e: KeyboardEvent): void {
  const b = allBindings().find((binding) => matches(binding, e))
  if (!b) return
  const target = e.target as HTMLElement | null
  const inEditor = !!target?.closest?.('.cm-editor')
  if (b.whenEditor === 'skip' && inEditor) return // let CodeMirror handle it
  e.preventDefault()
  if (b.command === '__palette') togglePalette()
  else void runCommand(b.command)
}

/** Human-readable hint for a command's binding (⌘⇧P on mac, Ctrl+Shift+P else). */
export function keybindingHint(commandId: string): string {
  const b = allBindings().find((x) => x.command === commandId)
  if (!b) return ''
  if (isMac) {
    let s = ''
    if (b.ctrl) s += '⌃'
    if (b.alt) s += '⌥'
    if (b.shift) s += '⇧'
    if (b.mod) s += '⌘'
    return s + (b.key === '`' ? '`' : b.key.toUpperCase())
  }
  const parts: string[] = []
  if (b.mod || b.ctrl) parts.push('Ctrl')
  if (b.alt) parts.push('Alt')
  if (b.shift) parts.push('Shift')
  parts.push(b.key === '`' ? '`' : b.key.toUpperCase())
  return parts.join('+')
}
