import { fileService } from '@/services/fileService'
import { retrieve, type Hit } from '@/services/crucible'
import { isWindowsPath } from '@/services/paths'

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

/** A tool-approval outcome. `always` means "and remember this" — session-wide
 *  for a file action, persisted to the command allowlist for a run_command. */
export type ApprovalDecision = 'allow' | 'always' | 'deny'

export interface ToolCtx {
  clientId: string
  /** The project's roots — the scope boundary. Every file path the model
   *  supplies is confined to the union of these (see `resolveInScope`); the
   *  first is the primary root used for search/grep cwd. */
  roots: string[]
  /** Commands that run without a prompt (Claude Code's allow rules). */
  agentCommands: string[]
  /** Commands refused outright, no prompt (Claude Code's deny rules). */
  commandDeny?: string[]
  /** Persist a command prefix to the allowlist after an "allow always". */
  rememberCommand?: (cmd: string) => void
  /** Ask the user to approve a mutating action; the decision drives whether it
   *  proceeds and whether it is remembered. */
  approve: (a: { name: string; summary: string; diff?: string }) => Promise<ApprovalDecision>
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

/** True when `cmd` matches a prefix list at a token boundary. Shared by the
 *  allow and deny checks — identical matching, opposite meaning. */
function commandMatches(cmd: string, list: string[]): boolean {
  const c = cmd.trim()
  return list.some((entry) => {
    const t = entry.trim()
    return !!t && (c === t || c.startsWith(t + ' '))
  })
}

/** True when `cmd` matches the per-agent allowlist (prefix, token-aware). */
export function isAgentCommandAllowed(cmd: string, allow: string[]): boolean {
  return commandMatches(cmd, allow)
}

/** True when `cmd` matches a deny rule — refused outright, no prompt. */
export function isAgentCommandDenied(cmd: string, deny: string[]): boolean {
  return commandMatches(cmd, deny)
}

/** Whether `abs` is `root` itself or lives beneath it. Both must already be
 *  normalized (forward slashes, no trailing slash); `fold` case-folds on Windows
 *  where paths are case-insensitive, and is identity elsewhere. */
function within(root: string, abs: string, fold: (s: string) => string): boolean {
  const r = fold(root)
  const a = fold(abs)
  return a === r || a.startsWith(r + '/')
}

/** Last segment of a normalized (forward-slash) path. Unlike `paths.baseName`,
 *  this assumes forward slashes, so it splits a normalized Windows root
 *  (`C:/Users/x` → `x`) that the OS-aware helper would leave whole. */
function lastSegment(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Normalize an absolute path and refuse `..`, so `/proj/../etc` cannot slip
 *  past a containment check. */
function cleanAbsolute(p: string): string {
  const s = p.replace(/\\/g, '/')
  const winDrive = /^[A-Za-z]:/.test(s)
  const parts = s.split('/')
  const head = winDrive ? (parts.shift() ?? '') : ''
  const out: string[] = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw new Error(`path escapes the project scope: ${p}`)
    out.push(seg)
  }
  const joined = out.join('/')
  return winDrive ? `${head}/${joined}`.replace(/\/+$/, '') : `/${joined}`.replace(/\/+$/, '') || '/'
}

/**
 * Resolve a model-supplied path within a project's **root set** — the agent
 * scope boundary. The result is guaranteed to sit inside one of `roots`, or this
 * throws. Three cases:
 *  - **Absolute path** — accepted only if contained by some root (so the model
 *    *can* reach any root explicitly, but `/etc/passwd` is refused).
 *  - **`<root-basename>/…`** — a relative path whose first segment names a root's
 *    basename resolves under that root (how the model reaches a non-primary root
 *    in a multi-root project).
 *  - **plain relative** — resolves under the primary root, `..` rejected.
 */
export function resolveInScope(roots: string[], rel: string): string {
  if (!roots.length) throw new Error('the project has no roots in scope')
  // Any Windows-style root switches the whole set to Windows semantics:
  // case-insensitive matching (paths there are case-insensitive).
  const win = roots.some(isWindowsPath)
  const fold = (s: string) => (win ? s.toLowerCase() : s)
  const norm = roots.map((r) => r.replace(/\\/g, '/').replace(/\/+$/, ''))

  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) {
    const abs = cleanAbsolute(rel)
    if (norm.some((r) => within(r, abs, fold))) return abs
    throw new Error(`path is outside the project scope: ${rel}`)
  }

  const segs = rel.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')
  const named = segs.length ? norm.find((r) => fold(lastSegment(r)) === fold(segs[0])) : undefined
  // resolveInRoot enforces the no-`..`/no-absolute invariant within the chosen
  // base, and the base is one of the roots, so the result is in scope.
  return named ? resolveInRoot(named, segs.slice(1).join('/')) : resolveInRoot(norm[0], rel)
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
      const abs = resolveInScope(ctx.roots, str('path'))
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
      const abs = resolveInScope(ctx.roots, str('path'))
      const entries = await fileService.list(ctx.clientId, abs)
      return { output: entries.map((e) => `${e.type === 'dir' ? '📁' : '  '} ${e.name}`).join('\n') || '(empty)' }
    }
    case 'search_code': {
      const hits: Hit[] = await retrieve(ctx.clientId, ctx.roots[0], str('query'), num('k') ?? 8)
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
      const res = await fileService.exec(ctx.clientId, cmd, ctx.roots[0], { timeoutSec: 60, timeoutMs: 65_000 })
      if (res.code !== 0 && !res.stdout) {
        // rg exits 1 on "no matches" — report that rather than erroring.
        return { output: res.code === 1 ? 'No matches.' : (res.stderr || res.error || `grep exit ${res.code}`).trim() }
      }
      return { output: clip(res.stdout) || 'No matches.' }
    }
    case 'run_command': {
      const command = str('command')
      // Claude Code's permission model: deny rules win outright; allow rules run
      // without a prompt; anything else asks, and "allow always" remembers the
      // prefix. A shell command is NOT confined by the cwd — say so in the prompt.
      if (isAgentCommandDenied(command, ctx.commandDeny ?? [])) {
        throw new Error(`command blocked by the project's deny rules: "${command}"`)
      }
      if (!isAgentCommandAllowed(command, ctx.agentCommands)) {
        const decision = await ctx.approve({
          name,
          summary: `Run \`${command}\`  ⚠ a shell command can reach outside the project`,
        })
        if (decision === 'deny') throw new Error('command denied by the user')
        if (decision === 'always') ctx.rememberCommand?.(command)
      }
      if (ctx.aborted()) throw new Error('stopped')
      const cwd = str('cwd') ? resolveInScope(ctx.roots, str('cwd')) : ctx.roots[0]
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
      const abs = resolveInScope(ctx.roots, str('path'))
      const content = str('content')
      const old = await fileService.read(ctx.clientId, abs).catch(() => '')
      const diff = unifiedDiff(old, content, str('path'))
      if ((await ctx.approve({ name, summary: `Write ${str('path')}`, diff })) === 'deny') {
        throw new Error('edit denied by the user')
      }
      await fileService.write(ctx.clientId, abs, content)
      ctx.onEdit?.(abs)
      return { output: `Wrote ${content.length} bytes to ${str('path')}`, diff }
    }
    case 'edit_file': {
      const abs = resolveInScope(ctx.roots, str('path'))
      const oldText = str('old_text')
      const newText = str('new_text')
      const content = await fileService.read(ctx.clientId, abs)
      if (!content.includes(oldText)) {
        throw new Error(`old_text not found in ${str('path')}`)
      }
      const updated = content.replace(oldText, newText)
      const diff = unifiedDiff(content, updated, str('path'))
      if ((await ctx.approve({ name, summary: `Edit ${str('path')}`, diff })) === 'deny') {
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
