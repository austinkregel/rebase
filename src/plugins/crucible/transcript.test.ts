import { describe, expect, it } from 'vitest'
import type { ChatTurn, ToolInvocation } from '@/services/crucibleState'
import { activityKey, basename, diffTone, groupTurns, isMutating, toolTone } from './transcript'

let seq = 0
function turn(partial: Partial<ChatTurn> & Pick<ChatTurn, 'role'>): ChatTurn {
  return { id: `t${++seq}`, text: '', createdAt: 0, ...partial }
}
function call(partial: Partial<ToolInvocation> = {}): ToolInvocation {
  return { id: `c${++seq}`, name: 'read_file', summary: 'Read x', status: 'done', ...partial }
}

describe('groupTurns', () => {
  it('labels only the first turn of a same-role run', () => {
    const grouped = groupTurns([
      turn({ role: 'user', text: 'hi' }),
      turn({ role: 'assistant', text: 'looking', toolCalls: [call()] }),
      turn({ role: 'assistant', text: 'more', toolCalls: [call()] }),
      turn({ role: 'assistant', text: 'done' }),
    ])
    expect(grouped.map((t) => t.showLabel)).toEqual([true, true, false, false])
  })

  it('treats the last tool-free assistant turn as the answer', () => {
    const grouped = groupTurns([
      turn({ role: 'user', text: 'hi' }),
      turn({ role: 'assistant', text: 'looking', toolCalls: [call()] }),
      turn({ role: 'assistant', text: 'the answer' }),
    ])
    expect(grouped.map((t) => t.isAnswer)).toEqual([false, false, true])
  })

  it('does not treat a turn with tool calls as the answer, even when last', () => {
    // A run that ends on a tool call has not answered anything yet.
    const grouped = groupTurns([turn({ role: 'assistant', text: 'reading', toolCalls: [call()] })])
    expect(grouped[0].isAnswer).toBe(false)
  })

  it('gives a still-streaming final turn full weight while it is written', () => {
    // Otherwise the answer snaps from muted to carded when streaming ends.
    const grouped = groupTurns([
      turn({ role: 'user', text: 'hi' }),
      turn({ role: 'assistant', text: 'partial', streaming: true }),
    ])
    expect(grouped[1].isAnswer).toBe(true)
  })

  it('never marks user or system turns as the answer', () => {
    const grouped = groupTurns([
      turn({ role: 'system', text: 'stopped' }),
      turn({ role: 'user', text: 'hi' }),
    ])
    expect(grouped.every((t) => !t.isAnswer)).toBe(true)
  })

  it('handles an empty transcript', () => {
    expect(groupTurns([])).toEqual([])
  })
})

describe('activityKey', () => {
  it('changes as streamed text grows', () => {
    const a = groupTurns([turn({ role: 'assistant', text: 'ab' })])
    const b = groupTurns([turn({ role: 'assistant', text: 'abc' })])
    expect(activityKey(a)).not.toBe(activityKey(b))
  })

  it('changes when a tool call changes status', () => {
    // Turns are mutated in place, so watching identity would miss this and the
    // transcript would stop following the run.
    const running = [turn({ role: 'assistant', toolCalls: [call({ status: 'running' })] })]
    const awaiting = [turn({ role: 'assistant', toolCalls: [call({ status: 'awaiting' })] })]
    expect(activityKey(running)).not.toBe(activityKey(awaiting))
  })

  it('changes when a tool call gains output', () => {
    const before = [turn({ role: 'assistant', toolCalls: [call()] })]
    const after = [turn({ role: 'assistant', toolCalls: [call({ output: 'result' })] })]
    expect(activityKey(before)).not.toBe(activityKey(after))
  })

  it('is stable across structurally equal but distinct turns', () => {
    // Comparing one array to itself would pass for any pure function, including
    // one that ignored its argument. Two separately-built arrays actually pin
    // that the key is derived from content.
    const a = [turn({ role: 'assistant', text: 'x', toolCalls: [call({ output: 'r' })] })]
    const b = [turn({ role: 'assistant', text: 'x', toolCalls: [call({ output: 'r' })] })]
    expect(activityKey(a)).toBe(activityKey(b))
  })

  it('does not collapse turns that differ only in tool output length', () => {
    const short = [turn({ role: 'assistant', toolCalls: [call({ output: 'ab' })] })]
    const long = [turn({ role: 'assistant', toolCalls: [call({ output: 'abc' })] })]
    expect(activityKey(short)).not.toBe(activityKey(long))
  })
})

describe('isMutating', () => {
  it('keeps write, edit, and run at full contrast', () => {
    // These change the project, so the user has to be able to read them.
    expect(isMutating('write_file')).toBe(true)
    expect(isMutating('edit_file')).toBe(true)
    expect(isMutating('run_command')).toBe(true)
  })

  it('lets read-only tools recede', () => {
    expect(isMutating('read_file')).toBe(false)
    expect(isMutating('list_files')).toBe(false)
    expect(isMutating('search_code')).toBe(false)
    expect(isMutating('grep')).toBe(false)
  })

  it('treats an unknown tool as mutating', () => {
    // Fail loud: a new tool shows at full contrast until it's classified.
    expect(isMutating('some_new_tool')).toBe(true)
  })
})

describe('toolTone', () => {
  it('maps each status to its semantic colour', () => {
    expect(toolTone('done')).toBe('text-green')
    expect(toolTone('error')).toBe('text-red')
    expect(toolTone('denied')).toBe('text-red')
    expect(toolTone('awaiting')).toBe('text-yellow')
    expect(toolTone('running')).toContain('animate-spin')
  })
})

describe('diffTone', () => {
  it('colours added, removed, and hunk lines', () => {
    expect(diffTone('+added')).toBe('text-green')
    expect(diffTone('-removed')).toBe('text-red')
    expect(diffTone('@@ -1,2 +1,3 @@')).toBe('text-accent')
    expect(diffTone(' context')).toBe('text-subtle')
  })
})

describe('basename', () => {
  it('takes the last path segment', () => {
    expect(basename('src/services/crucible.ts')).toBe('crucible.ts')
    expect(basename('/abs/path/file.rs')).toBe('file.rs')
    expect(basename('bare.txt')).toBe('bare.txt')
  })
})
