import { afterEach, describe, expect, it } from 'vitest'
import { indexerAsset } from './crucible'
import { buildMessages } from './crucibleChat'
import {
  _resetCrucibleState,
  addPin,
  appendSystemNote,
  appendTurn,
  indexStateFor,
  pinsFor,
  removePin,
  setIndexState,
  turnsFor,
} from './crucibleState'
import type { Hit } from './crucible'

afterEach(() => _resetCrucibleState())

describe('indexerAsset', () => {
  it('maps darwin/arm to the macos-arm64 release asset', () => {
    expect(indexerAsset('darwin', 'arm64')).toBe('rebase-indexer-macos-arm64')
  })
  it('defaults unknown linux distros + amd64 to linux-x86_64', () => {
    expect(indexerAsset('ubuntu', 'x86_64')).toBe('rebase-indexer-linux-x86_64')
    expect(indexerAsset('debian', 'amd64')).toBe('rebase-indexer-linux-x86_64')
  })
  it('maps linux/arm64 to the linux-arm64 asset', () => {
    expect(indexerAsset('ubuntu', 'aarch64')).toBe('rebase-indexer-linux-arm64')
  })
  it('rejects Windows agents (unix-only agent cache path)', () => {
    expect(() => indexerAsset('Microsoft Windows 11', 'x86_64')).toThrow(/Windows/)
  })
  it('rejects an Intel (x86_64) Mac agent with a clear error', () => {
    expect(() => indexerAsset('darwin', 'x86_64')).toThrow(/Intel Macs are not supported/)
    expect(() => indexerAsset('macOS', 'amd64')).toThrow(/Apple Silicon/)
  })
  it('maps an aarch64 Mac to the macos-arm64 asset', () => {
    expect(indexerAsset('darwin', 'aarch64')).toBe('rebase-indexer-macos-arm64')
  })
})

describe('crucibleState', () => {
  it('appends turns and assigns ids in order', () => {
    appendTurn('p1', { role: 'user', text: 'hi' })
    appendTurn('p1', { role: 'assistant', text: 'yo' })
    expect(turnsFor('p1').map((t) => t.role)).toEqual(['user', 'assistant'])
  })

  it('records system notes (e.g. allowlist grants) in the transcript', () => {
    appendSystemNote('p1', 'Authorized the indexer.')
    const turns = turnsFor('p1')
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe('system')
  })

  it('dedupes and removes pins', () => {
    addPin('p1', { path: '/a.ts', clientId: 'c' })
    addPin('p1', { path: '/a.ts', clientId: 'c' }) // dup ignored
    addPin('p1', { path: '/b.ts', clientId: 'c' })
    expect(pinsFor('p1').map((p) => p.path)).toEqual(['/a.ts', '/b.ts'])
    removePin('p1', '/a.ts')
    expect(pinsFor('p1').map((p) => p.path)).toEqual(['/b.ts'])
  })

  it('merges index state patches', () => {
    setIndexState('p1', { phase: 'building' })
    setIndexState('p1', { phase: 'ready', lastIndexedAt: 123 })
    expect(indexStateFor('p1')).toMatchObject({ phase: 'ready', lastIndexedAt: 123 })
  })
})

describe('buildMessages', () => {
  const hit: Hit = {
    relative: 'src/auth.ts',
    language: 'typescript',
    line_start: 10,
    line_end: 20,
    distance: 0.1,
    text: 'function login() {}',
  }

  it('orders system prompt, context, history, then the new user turn', () => {
    const msgs = buildMessages(
      [{ role: 'user', text: 'earlier' }],
      'where is auth?',
      [hit],
      [{ path: '/pinned.ts', content: 'export const x = 1' }],
    )
    expect(msgs[0].role).toBe('system') // system prompt
    expect(msgs[1].role).toBe('system') // retrieved context block
    expect(msgs[1].content).toContain('src/auth.ts:10-20')
    expect(msgs[1].content).toContain('/pinned.ts (pinned)')
    expect(msgs[2]).toEqual({ role: 'user', content: 'earlier' })
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'where is auth?' })
  })

  it('omits the context block when there is no retrieval or pins', () => {
    const msgs = buildMessages([], 'hello', [], [])
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello' })
  })
})
