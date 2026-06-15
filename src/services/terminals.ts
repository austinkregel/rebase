import { reactive } from 'vue'

/**
 * Terminal registry — a reactive singleton (like services/dock.ts) mirroring the
 * open terminal panels so the Tools-column "Terminals" view, tab titles, and
 * kill/focus commands share one source of truth. Each Terminal.vue registers on
 * mount and patches its status/exit as the shell lifecycle progresses.
 */
export type TerminalStatus = 'connecting' | 'live' | 'closed' | 'error'

export interface TerminalEntry {
  panelId: string
  seq: number
  /** The server this terminal is bound to (snapshotted at open time). */
  clientId: string
  status: TerminalStatus
  /** Best-effort exit reason for a closed shell. */
  exitReason?: string
  /** Tab/list label. */
  title: string
}

const state = reactive({
  entries: [] as TerminalEntry[],
  activePanelId: null as string | null,
})

export function registerTerminal(entry: TerminalEntry): () => void {
  const i = state.entries.findIndex((e) => e.panelId === entry.panelId)
  if (i !== -1) state.entries.splice(i, 1, entry)
  else state.entries.push(entry)
  return () => {
    const j = state.entries.findIndex((e) => e.panelId === entry.panelId)
    if (j !== -1) state.entries.splice(j, 1)
  }
}

export function updateTerminal(panelId: string, patch: Partial<TerminalEntry>): void {
  const e = state.entries.find((x) => x.panelId === panelId)
  if (e) Object.assign(e, patch)
}

export function terminalEntries(): TerminalEntry[] {
  return state.entries
}

export function terminalCount(): number {
  return state.entries.length
}

export function setActiveTerminal(panelId: string | null): void {
  state.activePanelId = panelId
}

export function activeTerminalPanelId(): string | null {
  return state.activePanelId
}
