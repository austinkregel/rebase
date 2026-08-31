import { describe, expect, it, vi } from 'vitest'
import {
  argSchemaFor,
  isAgentCommandAllowed,
  isAgentCommandDenied,
  resolveInScope,
  isValidLeafName,
  needsArgSynthesis,
  parseToolCall,
  resolveInRoot,
  runTool,
  toolSummary,
  unifiedDiff,
  TOOL_SCHEMAS,
  type ToolCtx,
} from './crucibleTools'
import type { Surfaced } from './crucibleState'

// runTool talks to the agent through these; stub them so the tests exercise the
// surfaced-set authority + scope logic, not the transport. `files` is hoisted so
// the (also-hoisted) vi.mock factory can close over it.
const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }))
vi.mock('@/services/fileService', () => ({
  FileOpError: class extends Error {},
  fileService: {
    read: vi.fn(async (_c: string, abs: string) => {
      if (files.has(abs)) return files.get(abs)!
      throw new Error('not found')
    }),
    // read_file now routes through fileContent.readTextForAgent → stat + readBytes.
    stat: vi.fn(async () => null),
    readBytes: vi.fn(async (_c: string, abs: string) => {
      if (files.has(abs)) return new TextEncoder().encode(files.get(abs)!)
      throw new Error('not found')
    }),
    write: vi.fn(async (_c: string, abs: string, content: string) => {
      files.set(abs, content)
    }),
    list: vi.fn(async () => [
      { name: 'a.ts', type: 'file' as const },
      { name: 'sub', type: 'dir' as const },
    ]),
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    execCancellable: vi.fn(() => ({
      result: Promise.resolve({ code: 0, stdout: 'ok', stderr: '' }),
      cancel: () => {},
    })),
  },
}))
vi.mock('@/services/crucible', () => ({ retrieve: vi.fn(async () => []) }))

const emptySurfaced = (): Surfaced => ({ files: new Set(), dirs: new Set() })

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
    surfaced: emptySurfaced(),
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

  it('writes an in-scope, surfaced path after approval', async () => {
    // #2 gates writes to the surfaced set, so seed the target as already-read.
    const ctx = baseCtx({ surfaced: { files: new Set(['/home/u/proj/src/a.ts']), dirs: new Set() } })
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

// --- #2: the surfaced-set authority -----------------------------------------

describe('runTool — surfaced-set authority (#2)', () => {
  const ROOT = '/home/u/proj'
  const baseCtx = (over: Partial<ToolCtx> = {}): ToolCtx => ({
    clientId: 'n',
    roots: [ROOT],
    agentCommands: [],
    commandDeny: [],
    rememberCommand: vi.fn(),
    surfaced: emptySurfaced(),
    approve: vi.fn(async () => 'allow'),
    onCancel: () => {},
    aborted: () => false,
    ...over,
  })

  it('reading a file surfaces it (registry populates on read)', async () => {
    const ctx = baseCtx()
    files.set(`${ROOT}/src/a.ts`, 'hello world')
    await runTool('read_file', { path: 'src/a.ts' }, ctx)
    expect(ctx.surfaced.files.has(`${ROOT}/src/a.ts`)).toBe(true)
  })

  it('listing a directory surfaces the dir and its entries (registry populates on list)', async () => {
    const ctx = baseCtx()
    await runTool('list_files', { path: 'src' }, ctx)
    expect(ctx.surfaced.dirs.has(`${ROOT}/src`)).toBe(true)
    // child file → files, child dir → dirs
    expect(ctx.surfaced.files.has(`${ROOT}/src/a.ts`)).toBe(true)
    expect(ctx.surfaced.dirs.has(`${ROOT}/src/sub`)).toBe(true)
  })

  it('refuses editing a file that was never surfaced, before touching it', async () => {
    const ctx = baseCtx()
    files.set(`${ROOT}/src/a.ts`, 'hello world')
    await expect(runTool('edit_file', { path: 'src/a.ts', old_text: 'hello', new_text: 'hi' }, ctx)).rejects.toThrow(
      /read the file first|only surfaced/i,
    )
    expect(ctx.approve).not.toHaveBeenCalled()
  })

  it('allows editing a file after it was read (read-then-edit)', async () => {
    const ctx = baseCtx()
    files.set(`${ROOT}/src/a.ts`, 'hello world')
    await runTool('read_file', { path: 'src/a.ts' }, ctx)
    const out = await runTool('edit_file', { path: 'src/a.ts', old_text: 'hello', new_text: 'hi' }, ctx)
    expect(out.output).toMatch(/Edited/)
    expect(ctx.approve).toHaveBeenCalledTimes(1)
  })

  it('inserts new_text literally, not as a $-replacement pattern', async () => {
    // `$&` / `$1` in new_text must be written verbatim (a plain String.replace
    // would expand them). Also verify only the first match is replaced.
    const ctx = baseCtx()
    files.set(`${ROOT}/src/a.ts`, 'foo foo')
    await runTool('read_file', { path: 'src/a.ts' }, ctx)
    await runTool('edit_file', { path: 'src/a.ts', old_text: 'foo', new_text: '$& $1 bar' }, ctx)
    expect(files.get(`${ROOT}/src/a.ts`)).toBe('$& $1 bar foo')
  })

  it('refuses a write to an un-surfaced path before ever asking for approval', async () => {
    const ctx = baseCtx()
    await expect(runTool('write_file', { path: 'src/new.ts', content: 'x' }, ctx)).rejects.toThrow(
      /read the file .* or list its directory/i,
    )
    expect(ctx.approve).not.toHaveBeenCalled()
  })

  it('allows overwriting a surfaced file', async () => {
    const ctx = baseCtx()
    files.set(`${ROOT}/src/a.ts`, 'hello world')
    await runTool('read_file', { path: 'src/a.ts' }, ctx)
    const out = await runTool('write_file', { path: 'src/a.ts', content: 'replaced' }, ctx)
    expect(out.output).toMatch(/Wrote/)
  })

  it('allows creating a NEW file in a listed directory (dir + name)', async () => {
    const ctx = baseCtx()
    await runTool('list_files', { path: 'src' }, ctx)
    const out = await runTool('write_file', { dir: 'src', name: 'new.ts', content: 'x' }, ctx)
    expect(out.output).toMatch(/Wrote/)
    expect(files.get(`${ROOT}/src/new.ts`)).toBe('x')
  })

  it('allows creating a NEW file addressed by a full path under a listed directory', async () => {
    const ctx = baseCtx()
    await runTool('list_files', { path: 'src' }, ctx)
    const out = await runTool('write_file', { path: 'src/created.ts', content: 'y' }, ctx)
    expect(out.output).toMatch(/Wrote/)
    expect(files.get(`${ROOT}/src/created.ts`)).toBe('y')
  })

  it('refuses creating a file in an UNLISTED directory', async () => {
    const ctx = baseCtx()
    await expect(runTool('write_file', { dir: 'src', name: 'new.ts', content: 'x' }, ctx)).rejects.toThrow(
      /list that directory first/i,
    )
    expect(ctx.approve).not.toHaveBeenCalled()
  })

  it('rejects a leaf name with separators or traversal', async () => {
    const ctx = baseCtx()
    await runTool('list_files', { path: 'src' }, ctx)
    for (const bad of ['a/b.ts', '..', 'a\\b', '']) {
      await expect(runTool('write_file', { dir: 'src', name: bad, content: 'x' }, ctx)).rejects.toThrow()
    }
  })

  it('still enforces scope confinement (resolveInRoot) beneath the surfaced check', async () => {
    const ctx = baseCtx()
    // traversal is rejected by the scope layer regardless of the surfaced set
    await expect(runTool('edit_file', { path: '../evil', old_text: 'a', new_text: 'b' }, ctx)).rejects.toThrow(
      /escapes/,
    )
  })
})

// --- #3: schema generators + adaptive validator -----------------------------

describe('isValidLeafName', () => {
  it('accepts a single segment, rejects separators / dot-names', () => {
    expect(isValidLeafName('foo.ts')).toBe(true)
    expect(isValidLeafName('a/b')).toBe(false)
    expect(isValidLeafName('a\\b')).toBe(false)
    expect(isValidLeafName('..')).toBe(false)
    expect(isValidLeafName('.')).toBe(false)
    expect(isValidLeafName('')).toBe(false)
  })
})

describe('argSchemaFor — Phase-B schema is built from the surfaced set (#3)', () => {
  const surfaced: Surfaced = {
    files: new Set(['/p/src/bar.ts', '/p/src/foo.ts']),
    dirs: new Set(['/p/src']),
  }

  it('edit_file constrains the target to exactly the surfaced files', () => {
    const s = argSchemaFor('edit_file', surfaced)!
    expect(s.properties!.path.enum).toEqual(['/p/src/bar.ts', '/p/src/foo.ts'])
    // free-text fields stay unconstrained
    expect(s.properties!.old_text.enum).toBeUndefined()
    expect(s.properties!.new_text.enum).toBeUndefined()
    expect(s.required).toEqual(['path', 'old_text', 'new_text'])
  })

  it('write_file leaves `path` free-form (new-file creates) but constrains the new-file dir to dirs', () => {
    const s = argSchemaFor('write_file', surfaced)!
    // `path` is intentionally NOT enum-constrained: a new file addressed by full
    // path must be expressible (M13). resolveWriteTarget still gates the target.
    expect(s.properties!.path.enum).toBeUndefined()
    expect(s.properties!.path.type).toBe('string')
    expect(s.properties!.dir.enum).toEqual(['/p/src'])
    expect(s.properties!.name.enum).toBeUndefined()
    expect(s.properties!.content.enum).toBeUndefined()
  })

  it('returns null for tools with no constrainable authority field', () => {
    expect(argSchemaFor('read_file', surfaced)).toBeNull()
    expect(argSchemaFor('run_command', surfaced)).toBeNull()
    expect(argSchemaFor('grep', surfaced)).toBeNull()
  })
})

describe('needsArgSynthesis — the adaptive Phase-B trigger (#3)', () => {
  const surfaced: Surfaced = { files: new Set(['/p/a.ts']), dirs: new Set(['/p']) }

  it('does NOT fire when the constrained field already holds a surfaced value', () => {
    const s = argSchemaFor('edit_file', surfaced)!
    expect(needsArgSynthesis(s, { path: '/p/a.ts', old_text: 'x', new_text: 'y' })).toBe(false)
  })

  it('fires when a constrained field holds a value outside its enum', () => {
    const s = argSchemaFor('edit_file', surfaced)!
    expect(needsArgSynthesis(s, { path: 'guessed.ts', old_text: 'x', new_text: 'y' })).toBe(true)
  })

  it('fires when a required constrained field is missing', () => {
    const s = argSchemaFor('edit_file', surfaced)!
    expect(needsArgSynthesis(s, { old_text: 'x', new_text: 'y' })).toBe(true)
  })

  it('does NOT fire on a free-text-only mismatch (only enum fields count)', () => {
    const s = argSchemaFor('write_file', surfaced)!
    // valid overwrite target + free content → no synthesis, even though `name`
    // (free text) is absent
    expect(needsArgSynthesis(s, { path: '/p/a.ts', content: 'whatever' })).toBe(false)
  })

  it('fires when the new-file dir is not one of the surfaced dirs', () => {
    const s = argSchemaFor('write_file', surfaced)!
    expect(needsArgSynthesis(s, { dir: '/p/elsewhere', name: 'x.ts', content: 'z' })).toBe(true)
  })

  it('does NOT fire for a write_file new-file path outside the surfaced set (M13)', () => {
    // A legitimate new-file create by full path must not be forced into Phase-B
    // arg synthesis (which would redirect it onto an existing surfaced file).
    const s = argSchemaFor('write_file', surfaced)!
    expect(needsArgSynthesis(s, { path: '/p/brand-new.ts', content: 'z' })).toBe(false)
  })
})
