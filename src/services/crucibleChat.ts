import { reactive } from 'vue'
import { Channel, invoke } from '@tauri-apps/api/core'
import { fileService } from '@/services/fileService'
import { notify } from '@/services/notifications'
import { useSettingsStore } from '@/stores/settings'
import type { Project } from '@/stores/projects'
import { retrieve, type Hit } from '@/services/crucible'
import {
  appendTurn,
  turnsFor,
  updateTurn,
  type ChatPin,
  type Citation,
} from '@/services/crucibleState'

export type { ChatPin }

/**
 * Crucible chat — a Cursor-style, read-only RAG conversation over the project's
 * Crucible index. Context per turn = auto-retrieved top-k chunks + any @-pinned
 * files. The provider seam (`ChatProvider`) keeps the door open for an agentic
 * "apply edit" capability later without reworking the UI.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamOptions {
  ollama: string
  model: string
}

/** The streaming backend behind the chat. Today: local Ollama via Tauri. */
export interface ChatProvider {
  stream(
    messages: ChatMessage[],
    opts: StreamOptions,
    onToken: (token: string) => void,
  ): Promise<void>
}

/** Streams `POST {ollama}/api/chat` through the Rust core (Channel of tokens). */
class OllamaProvider implements ChatProvider {
  async stream(
    messages: ChatMessage[],
    opts: StreamOptions,
    onToken: (token: string) => void,
  ): Promise<void> {
    const channel = new Channel<string>()
    channel.onmessage = (token) => onToken(token)
    await invoke('crucible_chat', {
      ollama: opts.ollama,
      model: opts.model,
      messages,
      onToken: channel,
    })
  }
}

let provider: ChatProvider = new OllamaProvider()
/** Swap the provider (tests / future agentic backend). */
export function setChatProvider(p: ChatProvider): void {
  provider = p
}

/** User-facing chat options, toggled from the panel. */
export const chatOptions = reactive({ autoContext: true })

const SYSTEM_PROMPT = [
  'You are Crucible, a coding assistant embedded in the Re:Base IDE.',
  "Answer questions about the user's codebase using the provided code context.",
  'Cite the files you rely on as `path:line`. Prefer the supplied context over guessing;',
  'if it is insufficient, say so plainly. Keep answers concise and concrete.',
].join(' ')

/** Cap how much prior conversation we replay, to bound the prompt size. */
const HISTORY_LIMIT = 10
/** How many chunks to auto-retrieve per turn. */
const RETRIEVE_K = 8

interface ActiveStream {
  projectId: string
  turnId: string
  aborted: boolean
}
let active: ActiveStream | null = null

export function isStreaming(projectId: string): boolean {
  return !!active && active.projectId === projectId && !active.aborted
}

/** Stop rendering the in-flight assistant turn (drops further tokens). */
export function stop(): void {
  if (!active) return
  updateTurn(active.projectId, active.turnId, { streaming: false })
  active.aborted = true
  active = null
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
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]

  const ctx: string[] = []
  for (const h of hits) ctx.push(`// ${h.relative}:${h.line_start}-${h.line_end}\n${h.text}`)
  for (const p of pins) ctx.push(`// ${p.path} (pinned)\n${p.content}`)
  if (ctx.length) {
    messages.push({ role: 'system', content: `Relevant code from the project:\n\n${ctx.join('\n\n')}` })
  }

  for (const t of priorTurns.slice(-HISTORY_LIMIT)) {
    messages.push({ role: t.role, content: t.text })
  }
  messages.push({ role: 'user', content: userText })
  return messages
}

/**
 * Ask Crucible a question. Appends the user turn and a streaming assistant turn
 * to the project's transcript, gathers context, then streams the answer.
 */
export async function ask(project: Project, userText: string, pins: ChatPin[]): Promise<void> {
  const text = userText.trim()
  const root = project.rootPaths[0]
  if (!text || !root) return
  const pid = project.id
  const { clientId } = project

  // Snapshot history before adding the current exchange.
  const priorTurns = turnsFor(pid)
    .filter((t): t is typeof t & { role: 'user' | 'assistant' } =>
      (t.role === 'user' || t.role === 'assistant') && !!t.text && !t.streaming,
    )
    .map((t) => ({ role: t.role, text: t.text }))

  appendTurn(pid, { role: 'user', text })
  const assistant = appendTurn(pid, { role: 'assistant', text: '', streaming: true })
  const stream: ActiveStream = { projectId: pid, turnId: assistant.id, aborted: false }
  active = stream

  try {
    let hits: Hit[] = []
    if (chatOptions.autoContext) {
      try {
        hits = await retrieve(clientId, root, text, RETRIEVE_K)
      } catch {
        /* no index yet / search failed — answer without retrieved context */
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

    const messages = buildMessages(priorTurns, text, hits, pinContents)
    const { ollamaUrl, chatModel } = useSettingsStore().indexing

    let acc = ''
    await provider.stream(messages, { ollama: ollamaUrl, model: chatModel }, (token) => {
      if (stream.aborted) return
      acc += token
      updateTurn(pid, assistant.id, { text: acc })
    })

    if (!stream.aborted) {
      updateTurn(pid, assistant.id, { streaming: false, citations: hits.map(toCitation) })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    updateTurn(pid, assistant.id, { streaming: false, error: msg })
    notify.error('Crucible chat failed', { source: 'Crucible', body: msg })
  } finally {
    if (active === stream) active = null
  }
}
