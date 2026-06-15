import { reactive } from 'vue'

/**
 * Bridge for triggering Dockview actions from outside the Workbench (the status
 * tray / terminal plugin / context menus). The Workbench registers the callbacks
 * on mount; consumers call them (no-op until registered).
 */
export interface OpenTerminalOptions {
  /** Server to bind the terminal to (defaults to the active agent). */
  clientId?: string
  /** Directory to `cd` into once the shell is live (client-side approximation;
   *  the PTY protocol has no cwd field — see docs/PROTOCOL.md). */
  initialCwd?: string
}

export const dock = reactive<{
  openTerminal: ((opts?: OpenTerminalOptions) => void) | null
  focusTerminal: ((panelId: string) => void) | null
  closeTerminal: ((panelId: string) => void) | null
}>({
  openTerminal: null,
  focusTerminal: null,
  closeTerminal: null,
})
