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

export type ToolStatus = 'running' | 'awaiting' | 'done' | 'denied' | 'error'

/** A tool the agent invoked in a turn — rendered live in the feed so the user
 *  sees everything the agent does (read/search/run/edit). */
export interface ToolInvocation {
  id: string
  /** Tool name (read_file, search_code, run_command, edit_file, …). */
  name: string
  /** One-line human summary shown on the card (e.g. "Read src/x.ts:1-40"). */
  summary: string
  status: ToolStatus
  /** Captured stdout / result text (collapsible). */
  output?: string
  /** Unified diff for write/edit, shown before approval. */
  diff?: string
  error?: string
}

export interface ChatTurn {
  id: string
  role: ChatRole
  text: string
  citations?: Citation[]
  actions?: ChatAction[]
  /** Tool invocations made in this assistant turn, in order. */
  toolCalls?: ToolInvocation[]
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

/**
 * The conversation's **surfaced set**: the canonical absolute paths the agent has
 * actually revealed this conversation, via reads/lists/search/grep. It's the
 * bounded authority for mutations — the model may only edit a file it has read,
 * and only create inside a directory it has listed (see `crucibleTools`). Layered
 * on top of `resolveInScope`'s scope confinement, not a replacement for it.
 */
export interface Surfaced {
  /** Abs paths of files revealed by read/list/search/grep. */
  files: Set<string>
  /** Abs paths of directories revealed by list_files. */
  dirs: Set<string>
}

/** Metadata for one persisted conversation (no turns — loaded on demand). */
export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  lastMessageAt: number
}

const state = reactive({
  /** Index state keyed by project id. */
  index: {} as Record<string, IndexState>,
  /** Active conversation's turns, keyed by project id. */
  conversations: {} as Record<string, ChatTurn[]>,
  /** Pinned context files keyed by project id. */
  pins: {} as Record<string, ChatPin[]>,
  /** All conversation metadata for a project (newest first), keyed by project id. */
  conversationList: {} as Record<string, ConversationMeta[]>,
  /** Which conversation is currently shown for a project, keyed by project id. */
  activeConversationId: {} as Record<string, string>,
})

/**
 * The surfaced set is per-conversation, keyed by project id like the transcript.
 * Kept OUT of the reactive `state` on purpose: it's plumbing for the agent loop,
 * not something the UI renders, and reactive `Set` proxies would only add churn.
 */
const surfaced = new Map<string, Surfaced>()

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

/** Add a tool invocation card to an assistant turn; returns its id. */
export function appendToolCall(
  projectId: string,
  turnId: string,
  call: Omit<ToolInvocation, 'id'>,
): string {
  const turn = state.conversations[projectId]?.find((t) => t.id === turnId)
  if (!turn) return ''
  const inv: ToolInvocation = { ...call, id: nextId() }
  ;(turn.toolCalls ??= []).push(inv)
  return inv.id
}

/** Patch a tool invocation card (status/output/diff/error) in place. */
export function updateToolCall(
  projectId: string,
  turnId: string,
  callId: string,
  patch: Partial<ToolInvocation>,
): void {
  const turn = state.conversations[projectId]?.find((t) => t.id === turnId)
  const inv = turn?.toolCalls?.find((c) => c.id === callId)
  if (inv) Object.assign(inv, patch)
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
  // A conversation switch/reset also drops what was surfaced: authority to mutate
  // must not carry across conversations.
  surfaced.delete(projectId)
}

/** The conversation's surfaced set (created empty on first access). */
export function surfacedFor(projectId: string): Surfaced {
  let s = surfaced.get(projectId)
  if (!s) {
    s = { files: new Set(), dirs: new Set() }
    surfaced.set(projectId, s)
  }
  return s
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

export function conversationListFor(projectId: string): ConversationMeta[] {
  return state.conversationList[projectId] ?? []
}

export function activeConversationIdFor(projectId: string): string | undefined {
  return state.activeConversationId[projectId]
}

export function setConversationList(projectId: string, list: ConversationMeta[]): void {
  state.conversationList[projectId] = list
}

export function setActiveConversationId(projectId: string, id: string): void {
  state.activeConversationId[projectId] = id
}

/** Test/teardown helper. */
export function _resetCrucibleState(): void {
  state.index = {}
  state.conversations = {}
  state.pins = {}
  state.conversationList = {}
  state.activeConversationId = {}
  surfaced.clear()
  seq = 0
}
