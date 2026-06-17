import { fileService } from '@/services/fileService'
import { retrieve, type Hit } from '@/services/crucible'

/**
 * Crucible agent tools. The chat model calls these (native Ollama tool calling)
 * to read, search, run, and edit on the AGENT. Every call is surfaced in the
 * chat feed by the loop; mutating tools require approval; `run_command` is also
 * gated by an independent per-agent command allowlist (settings.agentCommands)
 * *before* the request leaves, on top of the agent's own exec allowlist.
 */

/** Native Ollama `tools` array passed with every chat step. */
export const TOOL_SCHEMAS = [
  fn('read_file', 'Read a file from the project (optionally a line range).', {
    path: { type: 'string', description: 'Path relative to the project root' },
    start_line: { type: 'number', description: '1-indexed start line (optional)' },
    end_line: { type: 'number', description: '1-indexed end line (optional)' },
  }, ['path']),
  fn('list_files', 'List entries in a project directory.', {
    path: { type: 'string', description: 'Directory relative to the project root (default: root)' },
  }, []),
  fn('search_code', "Semantic search of the project's code index for a natural-language query.", {
    query: { type: 'string', description: 'What to look for' },
    k: { type: 'number', description: 'Max results (default 8)' },
  }, ['query']),
  fn('grep', 'Literal/regex text search across the project (ripgrep).', {
    pattern: { type: 'string', description: 'Pattern (a single token; regex supported)' },
    max: { type: 'number', description: 'Max matches (default 50)' },
  }, ['pattern']),
  fn('run_command', 'Run a shell command in the project. Restricted to an allowlist; asks the user.', {
    command: { type: 'string', description: 'The command to run' },
    cwd: { type: 'string', description: 'Working dir relative to root (optional)' },
  }, ['command']),
  fn('write_file', 'Create or overwrite a file (shows a diff for approval).', {
    path: { type: 'string', description: 'Path relative to the project root' },
    content: { type: 'string', description: 'Full file content' },
  }, ['path', 'content']),
  fn('edit_file', 'Replace exact text in a file (shows a diff for approval).', {
    path: { type: 'string', description: 'Path relative to the project root' },
    old_text: { type: 'string', description: 'Exact text to replace' },
    new_text: { type: 'string', description: 'Replacement text' },
  }, ['path', 'old_text', 'new_text']),
]

function fn(name: string, description: string, props: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } }
}

export const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_code', 'grep'])
export const MUTATING_TOOLS = new Set(['run_command', 'write_file', 'edit_file'])

/** Subset of TOOL_SCHEMAS for modes that must not mutate (ask/plan). */
export const READ_ONLY_TOOL_SCHEMAS = TOOL_SCHEMAS.filter(
  (t) => READ_ONLY_TOOLS.has((t as { function: { name: string } }).function.name),
)

export interface ToolCtx {
  clientId: string
  root: string
  agentCommands: string[]
  /** Ask the user to approve a mutating action. Resolves true to proceed. */
  approve: (a: { name: string; summary: string; diff?: string }) => Promise<boolean>
  /** Register a cancel fn for an in-flight cancellable op (run_command). */
  onCancel: (cancel: () => void) => void
  /** Whether the loop was stopped (checked before long ops). */
  aborted: () => boolean
  /** Called when a write/edit succeeds (so the loop can mark the index stale). */
  onEdit?: (absPath: string) => void
}

export interface ToolOutcome {
  output: string
  /** Unified diff for write/edit (also shown pre-approval). */
  diff?: string
}

/** Normalize the model's tool_call into `{ name, args }`. */
export function parseToolCall(call: unknown): { name: string; args: Record<string, unknown> } {
  const fnObj = (call as { function?: { name?: string; arguments?: unknown } }).function ?? {}
  const name = String(fnObj.name ?? '')
  let args: Record<string, unknown> = {}
  const raw = fnObj.arguments
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      args = {}
    }
  } else if (raw && typeof raw === 'object') {
    args = raw as Record<string, unknown>
  }
  return { name, args }
}

/** A short, human one-liner for the tool card. */
export function toolSummary(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => String(args[k] ?? '')
  switch (name) {
    case 'read_file':
      return `Read ${s('path')}${args.start_line ? `:${s('start_line')}-${s('end_line')}` : ''}`
    case 'list_files':
      return `List ${s('path') || '.'}`
    case 'search_code':
      return `Search "${s('query')}"`
    case 'grep':
      return `Grep "${s('pattern')}"`
    case 'run_command':
      return `Run \`${s('command')}\``
    case 'write_file':
      return `Write ${s('path')}`
    case 'edit_file':
      return `Edit ${s('path')}`
    default:
      return name
  }
}

/** True when `cmd` matches the per-agent allowlist (prefix, token-aware). */
export function isAgentCommandAllowed(cmd: string, allow: string[]): boolean {
  const c = cmd.trim()
  return allow.some((entry) => {
    const t = entry.trim()
    return !!t && (c === t || c.startsWith(t + ' '))
  })
}

/** Resolve a model-supplied relative path under `root`, rejecting escapes. */
export function resolveInRoot(root: string, rel: string): string {
  const base = root.replace(/\/+$/, '')
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error(`path must be relative to the project root: ${rel}`)
  }
  const parts: string[] = []
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw new Error(`path escapes the project root: ${rel}`)
    parts.push(seg)
  }
  return parts.length ? `${base}/${parts.join('/')}` : base
}

/** Compact unified diff (common prefix/suffix + changed middle). */
export function unifiedDiff(oldText: string, newText: string, path: string): string {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const removed = a.slice(p, a.length - s)
  const added = b.slice(p, b.length - s)
  const out = [`--- a/${path}`, `+++ b/${path}`, `@@ -${p + 1},${removed.length} +${p + 1},${added.length} @@`]
  for (const l of removed) out.push(`-${l}`)
  for (const l of added) out.push(`+${l}`)
  return out.join('\n')
}

const MAX_OUTPUT = 16_000

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n… (truncated)' : s
}

/** Execute one tool call. Throws on policy block / denial / failure — the loop
 *  feeds the thrown message back to the model as the tool result. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome> {
  const str = (k: string) => String(args[k] ?? '')
  const num = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : undefined)

  switch (name) {
    case 'read_file': {
      const abs = resolveInRoot(ctx.root, str('path'))
      const content = await fileService.read(ctx.clientId, abs)
      const start = num('start_line')
      const end = num('end_line')
      if (start || end) {
        const lines = content.split('\n')
        const slice = lines.slice((start ?? 1) - 1, end ?? lines.length)
        return { output: clip(slice.join('\n')) }
      }
      return { output: clip(content) }
    }
    case 'list_files': {
      const abs = resolveInRoot(ctx.root, str('path'))
      const entries = await fileService.list(ctx.clientId, abs)
      return { output: entries.map((e) => `${e.type === 'dir' ? '📁' : '  '} ${e.name}`).join('\n') || '(empty)' }
    }
    case 'search_code': {
      const hits: Hit[] = await retrieve(ctx.clientId, ctx.root, str('query'), num('k') ?? 8)
      return {
        output:
          hits
            .map((h) => `${h.relative}:${h.line_start}-${h.line_end}\n${h.text.split('\n').slice(0, 4).join('\n')}`)
            .join('\n\n') || 'No matches.',
      }
    }
    case 'grep': {
      const max = num('max') ?? 50
      const cmd = `rg --line-number --no-heading --max-count ${max} -- ${str('pattern')}`
      const res = await fileService.exec(ctx.clientId, cmd, ctx.root, { timeoutSec: 60, timeoutMs: 65_000 })
      if (res.code !== 0 && !res.stdout) {
        // rg exits 1 on "no matches" — report that rather than erroring.
        return { output: res.code === 1 ? 'No matches.' : (res.stderr || res.error || `grep exit ${res.code}`).trim() }
      }
      return { output: clip(res.stdout) || 'No matches.' }
    }
    case 'run_command': {
      const command = str('command')
      if (!isAgentCommandAllowed(command, ctx.agentCommands)) {
        throw new Error(`command not permitted for the agent: "${command}" (not in the agent command allowlist)`)
      }
      if (!(await ctx.approve({ name, summary: `Run \`${command}\`` }))) {
        throw new Error('command denied by the user')
      }
      if (ctx.aborted()) throw new Error('stopped')
      const cwd = str('cwd') ? resolveInRoot(ctx.root, str('cwd')) : ctx.root
      const { result, cancel } = fileService.execCancellable(ctx.clientId, command, cwd, {
        timeoutSec: 15 * 60,
        timeoutMs: 15 * 60 * 1000 + 5_000,
      })
      ctx.onCancel(cancel)
      const res = await result
      const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
      return { output: clip(`(exit ${res.code})\n${out}`) }
    }
    case 'write_file': {
      const abs = resolveInRoot(ctx.root, str('path'))
      const content = str('content')
      const old = await fileService.read(ctx.clientId, abs).catch(() => '')
      const diff = unifiedDiff(old, content, str('path'))
      if (!(await ctx.approve({ name, summary: `Write ${str('path')}`, diff }))) {
        throw new Error('edit denied by the user')
      }
      await fileService.write(ctx.clientId, abs, content)
      ctx.onEdit?.(abs)
      return { output: `Wrote ${content.length} bytes to ${str('path')}`, diff }
    }
    case 'edit_file': {
      const abs = resolveInRoot(ctx.root, str('path'))
      const oldText = str('old_text')
      const newText = str('new_text')
      const content = await fileService.read(ctx.clientId, abs)
      if (!content.includes(oldText)) {
        throw new Error(`old_text not found in ${str('path')}`)
      }
      const updated = content.replace(oldText, newText)
      const diff = unifiedDiff(content, updated, str('path'))
      if (!(await ctx.approve({ name, summary: `Edit ${str('path')}`, diff }))) {
        throw new Error('edit denied by the user')
      }
      await fileService.write(ctx.clientId, abs, updated)
      ctx.onEdit?.(abs)
      return { output: `Edited ${str('path')}`, diff }
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
