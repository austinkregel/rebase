import { describe, expect, it } from 'vitest'
import {
  isAgentCommandAllowed,
  parseToolCall,
  resolveInRoot,
  toolSummary,
  unifiedDiff,
  TOOL_SCHEMAS,
} from './crucibleTools'

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
