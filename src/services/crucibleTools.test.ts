import { describe, expect, it, vi } from 'vitest'
import {
  isAgentCommandAllowed,
  isAgentCommandDenied,
  parseToolCall,
  resolveInRoot,
  resolveInScope,
  runTool,
  toolSummary,
  unifiedDiff,
  TOOL_SCHEMAS,
  type ToolCtx,
} from './crucibleTools'

// runTool talks to the agent through these; stub them so the tests exercise the
// scope + permission logic, not the transport.
vi.mock('@/services/fileService', () => ({
  fileService: {
    read: vi.fn(async () => 'old content'),
    write: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    execCancellable: vi.fn(() => ({
      result: Promise.resolve({ code: 0, stdout: 'ok', stderr: '' }),
      cancel: () => {},
    })),
  },
}))
vi.mock('@/services/crucible', () => ({ retrieve: vi.fn(async () => []) }))

describe('resolveInRoot', () => {
  it('joins a relative path under the root', () => {
    expect(resolveInRoot('/home/u/proj', 'src/a.ts')).toBe('/home/u/proj/src/a.ts')
    expect(resolveInRoot('/home/u/proj/', './src/a.ts')).toBe('/home/u/proj/src/a.ts')
    expect(resolveInRoot('/home/u/proj', '')).toBe('/home/u/proj')
  })
  it('rejects traversal and absolute paths', () => {
    expect(() => resolveInRoot('/home/u/proj', '../etc/passwd')).toThrow(/escapes/)
    expect(() => resolveInRoot('/home/u/proj', 'src/../../x')).toThrow(/escapes/)
    expect(() => resolveInRoot('/home/u/proj', '/etc/passwd')).toThrow(/relative/)
    expect(() => resolveInRoot('/home/u/proj', 'C:\\x')).toThrow(/relative/)
  })
})

describe('resolveInScope — the project scope boundary', () => {
  const roots = ['/home/u/rebase', '/home/u/rebase-indexer/']

  it('resolves a plain relative path under the primary root', () => {
    expect(resolveInScope(roots, 'src/a.ts')).toBe('/home/u/rebase/src/a.ts')
    expect(resolveInScope(roots, './src/a.ts')).toBe('/home/u/rebase/src/a.ts')
    expect(resolveInScope(roots, '')).toBe('/home/u/rebase')
  })

  it('routes a <root-basename>/… path to that root', () => {
    expect(resolveInScope(roots, 'rebase-indexer/src/main.rs')).toBe('/home/u/rebase-indexer/src/main.rs')
    // the primary root can also be named explicitly
    expect(resolveInScope(roots, 'rebase/docs/x.md')).toBe('/home/u/rebase/docs/x.md')
  })

  it('accepts an absolute path only when contained by a root', () => {
    expect(resolveInScope(roots, '/home/u/rebase/src/a.ts')).toBe('/home/u/rebase/src/a.ts')
    expect(resolveInScope(roots, '/home/u/rebase-indexer')).toBe('/home/u/rebase-indexer')
  })

  it('refuses paths outside every root — the whole point', () => {
    expect(() => resolveInScope(roots, '/etc/passwd')).toThrow(/outside the project scope/)
    expect(() => resolveInScope(roots, '/home/u/other-project/x')).toThrow(/outside the project scope/)
    // a sibling that only shares a prefix is not contained
    expect(() => resolveInScope(roots, '/home/u/rebase-evil/x')).toThrow(/outside the project scope/)
    // traversal can't climb out, whether relative or dressed up as absolute
    expect(() => resolveInScope(roots, '../etc/passwd')).toThrow(/escapes/)
    expect(() => resolveInScope(roots, '/home/u/rebase/../../etc')).toThrow(/escapes/)
  })

  it('throws when the project has no roots (nothing is in scope)', () => {
    expect(() => resolveInScope([], 'a.ts')).toThrow(/no roots in scope/)
  })
})

describe('resolveInScope — Windows roots (case-insensitive, drive letters)', () => {
  const roots = ['C:\\Users\\me\\rebase', 'C:\\Users\\me\\rebase-indexer']

  it('resolves a relative path under the primary root, forward-slash output', () => {
    // We keep the existing forward-slash output convention (like resolveInRoot).
    expect(resolveInScope(roots, 'src\\a.ts')).toBe('C:/Users/me/rebase/src/a.ts')
    expect(resolveInScope(roots, 'src/a.ts')).toBe('C:/Users/me/rebase/src/a.ts')
  })

  it('routes <root-basename>/… to that root, case-insensitively', () => {
    expect(resolveInScope(roots, 'rebase-indexer/src/main.rs')).toBe('C:/Users/me/rebase-indexer/src/main.rs')
    expect(resolveInScope(roots, 'REBASE-INDEXER/x')).toBe('C:/Users/me/rebase-indexer/x')
  })

  it('accepts a contained absolute path regardless of case or slash style', () => {
    expect(resolveInScope(roots, 'C:\\Users\\me\\rebase\\a.ts')).toBe('C:/Users/me/rebase/a.ts')
    expect(resolveInScope(roots, 'c:/users/ME/rebase/a.ts')).toBe('c:/users/ME/rebase/a.ts')
  })

  it('refuses paths outside the roots and traversal', () => {
    expect(() => resolveInScope(roots, 'C:\\Windows\\System32\\drivers\\etc\\hosts')).toThrow(/outside the project scope/)
    expect(() => resolveInScope(roots, 'C:\\Users\\me\\rebase-evil\\x')).toThrow(/outside the project scope/)
    expect(() => resolveInScope(roots, 'C:\\Users\\me\\rebase\\..\\..\\Windows')).toThrow(/escapes/)
  })

  it('does not case-fold POSIX roots (still case-sensitive)', () => {
    expect(() => resolveInScope(['/home/u/rebase'], '/home/u/REBASE/a')).toThrow(/outside the project scope/)
  })
})

describe('runTool — scope boundary + command permissions are enforced', () => {
  const baseCtx = (over: Partial<ToolCtx> = {}): ToolCtx => ({
    clientId: 'n',
    roots: ['/home/u/proj'],
    agentCommands: [],
    commandDeny: [],
    rememberCommand: vi.fn(),
    approve: vi.fn(async () => 'allow'),
    onCancel: () => {},
    aborted: () => false,
    ...over,
  })

  it('refuses an out-of-scope write before ever asking for approval', async () => {
    const ctx = baseCtx()
    await expect(runTool('write_file', { path: '/etc/passwd', content: 'x' }, ctx)).rejects.toThrow(
      /outside the project scope/,
    )
    expect(ctx.approve).not.toHaveBeenCalled()
  })

  it('writes an in-scope path after approval', async () => {
    const ctx = baseCtx()
    const out = await runTool('write_file', { path: 'src/a.ts', content: 'new' }, ctx)
    expect(out.output).toMatch(/Wrote/)
    expect(ctx.approve).toHaveBeenCalledTimes(1)
  })

  it('a deny rule blocks a command with no prompt', async () => {
    const ctx = baseCtx({ commandDeny: ['rm -rf'] })
    await expect(runTool('run_command', { command: 'rm -rf /' }, ctx)).rejects.toThrow(/deny rules/)
    expect(ctx.approve).not.toHaveBeenCalled()
  })

  it('an allowlisted command runs without a prompt', async () => {
    const ctx = baseCtx({ agentCommands: ['echo'] })
    const out = await runTool('run_command', { command: 'echo hi' }, ctx)
    expect(ctx.approve).not.toHaveBeenCalled()
    expect(out.output).toContain('ok')
  })

  it('a non-allowlisted command asks, and "always" remembers it', async () => {
    const remember = vi.fn()
    const ctx = baseCtx({ approve: vi.fn(async () => 'always'), rememberCommand: remember })
    await runTool('run_command', { command: 'echo hi' }, ctx)
    expect(ctx.approve).toHaveBeenCalledTimes(1)
    expect(remember).toHaveBeenCalledWith('echo hi')
  })

  it('a denied command throws and is not run', async () => {
    const ctx = baseCtx({ approve: vi.fn(async () => 'deny') })
    await expect(runTool('run_command', { command: 'echo hi' }, ctx)).rejects.toThrow(/denied by the user/)
  })

  it('confines a command cwd to the scope', async () => {
    const ctx = baseCtx({ agentCommands: ['echo'] })
    await expect(runTool('run_command', { command: 'echo hi', cwd: '/etc' }, ctx)).rejects.toThrow(
      /outside the project scope/,
    )
  })
})

describe('isAgentCommandDenied', () => {
  it('prefix-matches like the allowlist, opposite meaning', () => {
    const deny = ['rm -rf', 'curl']
    expect(isAgentCommandDenied('rm -rf /tmp/x', deny)).toBe(true)
    expect(isAgentCommandDenied('curl http://evil', deny)).toBe(true)
    expect(isAgentCommandDenied('git status', deny)).toBe(false)
    expect(isAgentCommandDenied('anything', [])).toBe(false) // empty = deny nothing
  })
})

describe('isAgentCommandAllowed', () => {
  const allow = ['git status', 'go test', 'ls']
  it('prefix-matches at a token boundary', () => {
    expect(isAgentCommandAllowed('go test ./...', allow)).toBe(true)
    expect(isAgentCommandAllowed('git status', allow)).toBe(true)
    expect(isAgentCommandAllowed('ls', allow)).toBe(true)
  })
  it('rejects non-allowlisted or partial-token matches', () => {
    expect(isAgentCommandAllowed('rm -rf /', allow)).toBe(false)
    expect(isAgentCommandAllowed('gostuff', allow)).toBe(false) // not "go " boundary
    expect(isAgentCommandAllowed('git stat', allow)).toBe(false)
    expect(isAgentCommandAllowed('anything', [])).toBe(false) // empty = deny all
  })
})

describe('parseToolCall', () => {
  it('handles object arguments', () => {
    expect(parseToolCall({ function: { name: 'read_file', arguments: { path: 'a.ts' } } })).toEqual({
      name: 'read_file',
      args: { path: 'a.ts' },
    })
  })
  it('handles stringified JSON arguments', () => {
    expect(parseToolCall({ function: { name: 'grep', arguments: '{"pattern":"foo"}' } })).toEqual({
      name: 'grep',
      args: { pattern: 'foo' },
    })
  })
  it('degrades gracefully on malformed args', () => {
    expect(parseToolCall({ function: { name: 'x', arguments: 'not json' } })).toEqual({ name: 'x', args: {} })
  })
})

describe('toolSummary', () => {
  it('produces a one-liner per tool', () => {
    expect(toolSummary('run_command', { command: 'go test' })).toBe('Run `go test`')
    expect(toolSummary('read_file', { path: 'a.ts', start_line: 1, end_line: 9 })).toBe('Read a.ts:1-9')
    expect(toolSummary('edit_file', { path: 'b.ts' })).toBe('Edit b.ts')
  })
})

describe('unifiedDiff', () => {
  it('shows changed middle with -/+ lines and a hunk header', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.ts')
    expect(d).toContain('--- a/f.ts')
    expect(d).toContain('+++ b/f.ts')
    expect(d).toContain('-b')
    expect(d).toContain('+B')
    expect(d).not.toContain('-a') // common prefix untouched
  })
})

describe('TOOL_SCHEMAS', () => {
  it('declares the agent tools in Ollama function format', () => {
    const names = TOOL_SCHEMAS.map((t) => t.function.name)
    expect(names).toEqual(
      expect.arrayContaining(['read_file', 'list_files', 'search_code', 'grep', 'run_command', 'write_file', 'edit_file']),
    )
    for (const t of TOOL_SCHEMAS) {
      expect(t.type).toBe('function')
      expect(t.function.parameters.type).toBe('object')
    }
  })
})
