import { reactive } from 'vue'

/**
 * Shared, reactive Crucible state — the single source of truth for the index
 * lifecycle and the chat transcript, read by the chat panel + status-bar item
 * and written by both services. A plain `reactive` singleton (like
 * services/notifications.ts) so it has no Pinia/test setup and no import cycle
 * between crucible.ts (index) and crucibleChat.ts (chat).
 */

/** Where an index build/refresh is in its lifecycle. */
export type IndexPhase =
  | 'idle'
  | 'uploading'
  | 'building'
  | 'packing'
  | 'downloading'
  | 'ready'
  | 'stale'
  | 'error'

export interface IndexState {
  phase: IndexPhase
  /** Epoch ms of the last successful index, if any. */
  lastIndexedAt?: number
  error?: string
}

export type ChatRole = 'user' | 'assistant' | 'system'

/** A retrieved code location backing an assistant answer (click → open file). */
export interface Citation {
  relative: string
  lineStart: number
  lineEnd: number
  language: string
  distance: number
}

/**
 * Reserved hook for the agentic phase: an assistant turn may later carry
 * actions (e.g. "apply edit"). Rendered as a no-op today so the read-only chat
 * doesn't need a rewrite when Composer-style edits land.
 */
export interface ChatAction {
  id: string
  label: string
  kind: 'applyEdit'
  run?: () => void | Promise<void>
}

export interface ChatTurn {
  id: string
  role: ChatRole
  text: string
  citations?: Citation[]
  actions?: ChatAction[]
  /** True while the assistant turn is still streaming. */
  streaming?: boolean
  error?: string
  createdAt: number
}

/** A file pinned into the conversation as explicit context (@-mention). */
export interface ChatPin {
  path: string
  clientId: string
}

const state = reactive({
  /** Index state keyed by project id. */
  index: {} as Record<string, IndexState>,
  /** Chat transcript keyed by project id. */
  conversations: {} as Record<string, ChatTurn[]>,
  /** Pinned context files keyed by project id. */
  pins: {} as Record<string, ChatPin[]>,
})

let seq = 0
function nextId(): string {
  return `c${++seq}`
}

const DEFAULT_INDEX: IndexState = { phase: 'idle' }

export function indexStateFor(projectId: string): IndexState {
  return state.index[projectId] ?? DEFAULT_INDEX
}

export function setIndexState(projectId: string, patch: Partial<IndexState>): void {
  state.index[projectId] = { ...(state.index[projectId] ?? DEFAULT_INDEX), ...patch }
}

/** Transient phase update that keeps lastIndexedAt/error unless overridden. */
export function setIndexPhase(projectId: string, phase: IndexPhase): void {
  setIndexState(projectId, { phase })
}

export function turnsFor(projectId: string): ChatTurn[] {
  return state.conversations[projectId] ?? []
}

export function appendTurn(projectId: string, turn: Omit<ChatTurn, 'id' | 'createdAt'>): ChatTurn {
  const full: ChatTurn = { ...turn, id: nextId(), createdAt: Date.now() }
  ;(state.conversations[projectId] ??= []).push(full)
  return full
}

export function updateTurn(projectId: string, id: string, patch: Partial<ChatTurn>): void {
  const turn = state.conversations[projectId]?.find((t) => t.id === id)
  if (turn) Object.assign(turn, patch)
}

/**
 * Record a security/operational note in the chat log so changes the app makes on
 * the user's behalf (e.g. auto-authorizing the indexer in the exec allowlist)
 * are visible rather than silent.
 */
export function appendSystemNote(projectId: string, text: string): ChatTurn {
  return appendTurn(projectId, { role: 'system', text })
}

export function clearConversation(projectId: string): void {
  state.conversations[projectId] = []
}

export function pinsFor(projectId: string): ChatPin[] {
  return state.pins[projectId] ?? []
}

export function addPin(projectId: string, pin: ChatPin): void {
  const list = (state.pins[projectId] ??= [])
  if (!list.some((p) => p.path === pin.path && p.clientId === pin.clientId)) list.push(pin)
}

export function removePin(projectId: string, path: string): void {
  const list = state.pins[projectId]
  if (list) state.pins[projectId] = list.filter((p) => p.path !== path)
}

export function clearPins(projectId: string): void {
  state.pins[projectId] = []
}

/** Test/teardown helper. */
export function _resetCrucibleState(): void {
  state.index = {}
  state.conversations = {}
  state.pins = {}
  seq = 0
}
