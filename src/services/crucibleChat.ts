import { reactive } from 'vue'
import { Channel, invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/transport/contract'
import { fileService } from '@/services/fileService'
import { notify } from '@/services/notifications'
import { useSettingsStore } from '@/stores/settings'
import type { Project } from '@/stores/projects'
import { retrieve, type Hit } from '@/services/crucible'
import {
  appendTurn,
  appendToolCall,
  appendSystemNote,
  setIndexState,
  turnsFor,
  updateTurn,
  updateToolCall,
  clearConversation,
  conversationListFor,
  activeConversationIdFor,
  setConversationList,
  setActiveConversationId,
  type ChatPin,
  type ChatRole,
  type ChatTurn,
  type Citation,
  type ConversationMeta,
  type ToolInvocation,
} from '@/services/crucibleState'
import {
  TOOL_SCHEMAS,
  READ_ONLY_TOOL_SCHEMAS,
  READ_ONLY_TOOLS,
  parseToolCall,
  runTool,
  toolSummary,
  type ToolCtx,
} from '@/services/crucibleTools'

export type { ChatPin }

/**
 * Crucible chat — a Cursor-style **agent**. The model calls tools (read/search/
 * run/edit, native Ollama tool calling) in a loop until it answers. Every tool
 * action is rendered live in the feed; mutating tools require approval; a Stop
 * control halts the loop and kills any in-flight command on the agent.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** For role:'tool' results. */
  tool_name?: string
  /** For role:'assistant' messages that called tools (passed back verbatim). */
  tool_calls?: unknown[]
}

export interface ChatStepResult {
  content: string
  toolCalls: unknown[]
}

export interface StreamOptions {
  ollama: string
  model: string
  tools?: unknown[]
}

/** The backend behind one chat step. Streams content tokens + returns the final
 *  assistant message (content + any tool_calls). */
export interface ChatProvider {
  chat(
    messages: ChatMessage[],
    opts: StreamOptions,
    onToken: (token: string) => void,
  ): Promise<ChatStepResult>
}

/** One `/api/chat` step through the Rust core (Channel of content tokens). */
class OllamaProvider implements ChatProvider {
  async chat(
    messages: ChatMessage[],
    opts: StreamOptions,
    onToken: (token: string) => void,
  ): Promise<ChatStepResult> {
    const channel = new Channel<string>()
    channel.onmessage = (token) => onToken(token)
    const res = await invoke<{ content: string; tool_calls: unknown[] }>('crucible_chat', {
      ollama: opts.ollama,
      model: opts.model,
      messages,
      tools: opts.tools ?? null,
      onToken: channel,
    })
    return { content: res.content, toolCalls: res.tool_calls ?? [] }
  }
}

let provider: ChatProvider = new OllamaProvider()
/** Swap the provider (tests / alternate backend). */
export function setChatProvider(p: ChatProvider): void {
  provider = p
}

export type ChatMode = 'agent' | 'plan' | 'multi-task' | 'ask'

/** User-facing chat options. `mode` controls which tools and system prompt are used. */
export const chatOptions = reactive({ autoContext: true, mode: 'agent' as ChatMode })

const SYSTEM_PROMPTS: Record<ChatMode, string> = {
  agent: [
    'You are Crucible, a coding agent embedded in the Re:Base IDE.',
    'You have tools to read, list, semantically search, grep, run commands, and edit files',
    "in the user's project. Investigate with read_file/search_code/grep before answering or",
    'editing; make minimal, correct edits; cite files as `path:line`. Use run_command only',
    'when needed (it is restricted and the user must approve). When done, give a concise answer.',
  ].join(' '),
  ask: [
    'You are Crucible, a coding assistant embedded in the Re:Base IDE.',
    'Answer questions about the codebase clearly and concisely.',
    'You may use read_file, list_files, search_code, and grep to look up information.',
    'Do NOT modify any files — only read and answer. Cite relevant locations as `path:line`.',
  ].join(' '),
  plan: [
    'You are Crucible, a coding planner embedded in the Re:Base IDE.',
    "Produce a detailed, step-by-step implementation plan for the user's request.",
    'Use read_file, list_files, search_code, and grep to understand the codebase first.',
    'Output a numbered plan with specific file paths, line numbers, and exactly what to change.',
    'Do NOT edit any files — produce only the plan for the user to review.',
  ].join(' '),
  'multi-task': [
    'You are Crucible, a coding agent embedded in the Re:Base IDE.',
    'You have tools to read, list, semantically search, grep, run commands, and edit files.',
    'For complex requests, decompose the work into clearly-named sub-tasks and complete each',
    'one fully before moving to the next. Investigate first, make minimal correct edits,',
    'cite files as `path:line`. When all sub-tasks are done, give a concise summary.',
  ].join(' '),
}

const HISTORY_LIMIT = 10
const RETRIEVE_K = 8
const MAX_ITERS = 12
const MAX_CONSEC_FAILURES = 3

// --- Transcript persistence -------------------------------------------------

interface PersistedTurn {
  role: ChatRole
  text: string
  createdAt: number
  error?: string
  citations?: Citation[]
  toolCalls?: Pick<ToolInvocation, 'name' | 'summary' | 'status' | 'output' | 'diff' | 'error'>[]
}

function serializeTurn(t: ChatTurn): PersistedTurn {
  return {
    role: t.role,
    text: t.text,
    createdAt: t.createdAt,
    ...(t.error ? { error: t.error } : {}),
    ...(t.citations?.length ? { citations: t.citations } : {}),
    ...(t.toolCalls?.length
      ? {
          toolCalls: t.toolCalls.map(({ name, summary, status, output, diff, error }) => ({
            name,
            summary,
            status,
            output,
            diff,
            error,
          })),
        }
      : {}),
  }
}

async function persistTurns(pid: string, turns: ChatTurn[]): Promise<void> {
  if (!isTauri() || !turns.length) return
  const lines = turns.filter((t) => !t.streaming).map((t) => JSON.stringify(serializeTurn(t)))
  if (!lines.length) return

  try {
    let convId = activeConversationIdFor(pid)
    if (!convId) {
      convId = crypto.randomUUID()
      setActiveConversationId(pid, convId)
    }
    await invoke('transcript_append_to', { projectId: pid, conversationId: convId, lines })

    // Update or insert this conversation's metadata.
    const now = Date.now()
    const firstUserText = turns.find((t) => t.role === 'user')?.text?.trim() ?? ''
    const autoTitle = firstUserText.length > 0
      ? firstUserText.slice(0, 60) + (firstUserText.length > 60 ? '…' : '')
      : 'New conversation'
    const list = conversationListFor(pid)
    const existing = list.find((c) => c.id === convId)
    let updated: ConversationMeta[]
    if (existing) {
      updated = list.map((c) =>
        c.id === convId
          ? { ...c, lastMessageAt: now, title: c.title === 'New conversation' ? autoTitle : c.title }
          : c,
      )
    } else {
      const newMeta: ConversationMeta = { id: convId, title: autoTitle, createdAt: now, lastMessageAt: now }
      updated = [newMeta, ...list]
    }
    setConversationList(pid, updated)
    await invoke('transcript_save_meta', { projectId: pid, metaJson: JSON.stringify(updated) })
  } catch (err) {
    console.error('[Crucible] failed to persist conversation:', err)
  }
}

/** Load this project's conversation list and activate the most recent one.
 *  Called when a project becomes active in the chat panel. */
export async function loadConversations(pid: string): Promise<void> {
  if (!isTauri()) return
  try {
    const raw = await invoke<string>('transcript_list', { projectId: pid })
    const list: ConversationMeta[] = JSON.parse(raw)
    setConversationList(pid, list)
    console.log(`[Crucible] loaded ${list.length} conversations for project ${pid}`)
    if (list.length > 0 && !activeConversationIdFor(pid) && turnsFor(pid).length === 0) {
      await activateConversation(pid, list[0].id)
    }
  } catch {
    /* no transcript yet or Tauri unavailable */
  }
}

/** Switch to a different conversation — clears current turns and loads the
 *  requested one from disk. */
export async function activateConversation(pid: string, convId: string): Promise<void> {
  clearConversation(pid)
  setActiveConversationId(pid, convId)
  if (!isTauri()) return
  try {
    const lines = await invoke<string[]>('transcript_load_conversation', {
      projectId: pid,
      conversationId: convId,
    })
    for (const line of lines) {
      try {
        appendTurn(pid, JSON.parse(line) as PersistedTurn)
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no transcript yet or Tauri unavailable */
  }
}

/** Create a blank new conversation and make it active. */
export async function newConversation(pid: string): Promise<void> {
  const id = crypto.randomUUID()
  clearConversation(pid)
  setActiveConversationId(pid, id)
  const now = Date.now()
  const meta: ConversationMeta = { id, title: 'New conversation', createdAt: now, lastMessageAt: now }
  const list = [meta, ...conversationListFor(pid)]
  setConversationList(pid, list)
  if (!isTauri()) return
  try {
    await invoke('transcript_save_meta', { projectId: pid, metaJson: JSON.stringify(list) })
  } catch {
    /* non-critical */
  }
}

// ---------------------------------------------------------------------------

export type ApprovalDecision = 'allow' | 'always' | 'deny'

interface ActiveLoop {
  projectId: string
  aborted: boolean
  cancels: Set<() => void>
}
let activeLoop: ActiveLoop | null = null
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>()
const sessionApproved = new Set<string>()

export function isStreaming(projectId: string): boolean {
  return !!activeLoop && activeLoop.projectId === projectId && !activeLoop.aborted
}

/** Stop the agent: end the loop, cancel in-flight commands (kills them on the
 *  agent — not a disconnect), and deny any pending approval. */
export function stop(): void {
  if (!activeLoop) return
  activeLoop.aborted = true
  for (const cancel of activeLoop.cancels) {
    try {
      cancel()
    } catch {
      /* ignore */
    }
  }
  activeLoop.cancels.clear()
  for (const resolve of pendingApprovals.values()) resolve('deny')
  pendingApprovals.clear()
}

/** Resolve a pending tool approval (called from the card's buttons). */
export function resolveToolApproval(callId: string, decision: ApprovalDecision): void {
  pendingApprovals.get(callId)?.(decision)
}

function toCitation(h: Hit): Citation {
  return {
    relative: h.relative,
    lineStart: h.line_start,
    lineEnd: h.line_end,
    language: h.language,
    distance: h.distance,
  }
}

export function buildMessages(
  priorTurns: { role: 'user' | 'assistant'; text: string }[],
  userText: string,
  hits: Hit[],
  pins: { path: string; content: string }[],
  systemPrompt = SYSTEM_PROMPTS.agent,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
  const ctx: string[] = []
  for (const h of hits) ctx.push(`// ${h.relative}:${h.line_start}-${h.line_end}\n${h.text}`)
  for (const p of pins) ctx.push(`// ${p.path} (pinned)\n${p.content}`)
  if (ctx.length) {
    messages.push({ role: 'system', content: `Relevant code from the project:\n\n${ctx.join('\n\n')}` })
  }
  for (const t of priorTurns.slice(-HISTORY_LIMIT)) messages.push({ role: t.role, content: t.text })
  messages.push({ role: 'user', content: userText })
  return messages
}

/**
 * Run the agent loop for one user message: gather context, then repeatedly call
 * the model — executing any tools it requests (live in the feed) and feeding
 * results back — until it answers, hits the iteration cap, or is stopped.
 */
export async function ask(project: Project, userText: string, pins: ChatPin[]): Promise<void> {
  const text = userText.trim()
  const root = project.rootPaths[0]
  if (!text || !root) return
  const pid = project.id
  const { clientId } = project

  const priorTurns = turnsFor(pid)
    .filter((t): t is typeof t & { role: 'user' | 'assistant' } =>
      (t.role === 'user' || t.role === 'assistant') && !!t.text && !t.streaming,
    )
    .map((t) => ({ role: t.role, text: t.text }))

  const beforeCount = turnsFor(pid).length
  appendTurn(pid, { role: 'user', text })

  const loop: ActiveLoop = { projectId: pid, aborted: false, cancels: new Set() }
  activeLoop = loop

  const { ollamaUrl, chatModel, agentCommands } = useSettingsStore().indexing

  try {
    let hits: Hit[] = []
    if (chatOptions.autoContext) {
      try {
        hits = await retrieve(clientId, root, text, RETRIEVE_K)
      } catch {
        /* no index / search failed — proceed without retrieved context */
      }
    }
    const pinContents = (
      await Promise.all(
        pins.map(async (p) => {
          try {
            return { path: p.path, content: await fileService.read(p.clientId, p.path) }
          } catch {
            return null
          }
        }),
      )
    ).filter((p): p is { path: string; content: string } => p !== null)

    const systemPrompt = SYSTEM_PROMPTS[chatOptions.mode]
    const messages = buildMessages(priorTurns, text, hits, pinContents, systemPrompt)
    const tools =
      chatOptions.mode === 'agent' || chatOptions.mode === 'multi-task'
        ? TOOL_SCHEMAS
        : READ_ONLY_TOOL_SCHEMAS

    let consecutiveFailures = 0
    let lastAssistantId = ''

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      if (loop.aborted) break

      const assistant = appendTurn(pid, { role: 'assistant', text: '', streaming: true })
      lastAssistantId = assistant.id
      let acc = ''
      const { content, toolCalls } = await provider.chat(
        messages,
        { ollama: ollamaUrl, model: chatModel, tools },
        (tok) => {
          if (loop.aborted) return
          acc += tok
          updateTurn(pid, assistant.id, { text: acc })
        },
      )
      updateTurn(pid, assistant.id, { streaming: false, text: content || acc })

      if (loop.aborted || !toolCalls.length) break

      // Record the model's tool-calling turn, then run each tool.
      messages.push({ role: 'assistant', content, tool_calls: toolCalls })
      for (const raw of toolCalls) {
        if (loop.aborted) break
        const { name, args } = parseToolCall(raw)
        const callId = appendToolCall(pid, assistant.id, {
          name,
          summary: toolSummary(name, args),
          status: 'running',
        })

        const ctx: ToolCtx = {
          clientId,
          root,
          agentCommands,
          aborted: () => loop.aborted,
          onCancel: (cancel) => loop.cancels.add(cancel),
          onEdit: () => setIndexState(pid, { phase: 'stale' }),
          approve: async ({ name: n, summary, diff }) => {
            const key = `${n}:${summary}`
            if (sessionApproved.has(key)) return true
            updateToolCall(pid, assistant.id, callId, { status: 'awaiting', diff })
            const decision = await new Promise<ApprovalDecision>((resolve) =>
              pendingApprovals.set(callId, resolve),
            )
            pendingApprovals.delete(callId)
            if (decision === 'always') sessionApproved.add(key)
            if (decision === 'deny') {
              updateToolCall(pid, assistant.id, callId, { status: 'denied' })
              return false
            }
            updateToolCall(pid, assistant.id, callId, { status: 'running' })
            return true
          },
        }

        let resultText: string
        try {
          const outcome = await runTool(name, args, ctx)
          resultText = outcome.output
          updateToolCall(pid, assistant.id, callId, {
            status: 'done',
            output: outcome.output,
            diff: outcome.diff,
          })
          if (!READ_ONLY_TOOLS.has(name)) consecutiveFailures = 0
        } catch (err) {
          resultText = `Error: ${err instanceof Error ? err.message : String(err)}`
          const denied = /denied|stopped/i.test(resultText)
          updateToolCall(pid, assistant.id, callId, {
            status: denied ? 'denied' : 'error',
            error: resultText,
          })
          if (!denied) consecutiveFailures++
        }
        messages.push({ role: 'tool', tool_name: name, content: resultText })
      }

      if (consecutiveFailures >= MAX_CONSEC_FAILURES) {
        appendSystemNote(pid, '⚠ Stopped after repeated tool failures.')
        break
      }
    }

    // Attach the retrieved-context citations to the final answer turn.
    if (!loop.aborted && lastAssistantId && hits.length) {
      updateTurn(pid, lastAssistantId, { citations: hits.map(toCitation) })
    }
    if (loop.aborted) appendSystemNote(pid, '⏹ Stopped by you.')
    await persistTurns(pid, turnsFor(pid).slice(beforeCount))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    notify.error('Crucible chat failed', { source: 'Crucible', body: msg })
  } finally {
    if (activeLoop === loop) activeLoop = null
  }
}
