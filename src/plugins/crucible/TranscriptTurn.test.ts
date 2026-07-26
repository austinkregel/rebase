import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ChatTurn, ToolInvocation } from '@/services/crucibleState'
import MarkdownText from './MarkdownText.vue'
import TranscriptTurn from './TranscriptTurn.vue'
import { groupTurns, type GroupedTurn } from './transcript'

function grouped(partial: Partial<ChatTurn> & Pick<ChatTurn, 'role'>): GroupedTurn {
  return groupTurns([{ id: 't1', text: '', createdAt: 0, ...partial }])[0]
}

const mountTurn = (turn: GroupedTurn) => mount(TranscriptTurn, { props: { turn } })

describe('role rendering', () => {
  it('renders a system note as a quiet italic pill', () => {
    const w = mountTurn(grouped({ role: 'system', text: '⏹ Stopped by you.' }))
    expect(w.find('.italic').text()).toBe('⏹ Stopped by you.')
  })

  it('renders user text verbatim, never through the markdown renderer', () => {
    // A user typing `# heading` or `<b>` must see what they typed, and their
    // input must never reach an HTML renderer. (What that renderer does with
    // model output is MarkdownText's own contract — see MarkdownText.test.ts.)
    const w = mountTurn(grouped({ role: 'user', text: '# not a heading' }))
    expect(w.text()).toContain('# not a heading')
    expect(w.find('.whitespace-pre-wrap').exists()).toBe(true)
    expect(w.findComponent(MarkdownText).exists()).toBe(false)
  })

  it('routes assistant text through the markdown renderer', () => {
    const w = mountTurn(grouped({ role: 'assistant', text: '# heading' }))
    expect(w.findComponent(MarkdownText).props('text')).toBe('# heading')
  })

  it('shows the role label only when the turn opens a run', () => {
    const first = mountTurn(grouped({ role: 'user', text: 'hi' }))
    expect(first.text()).toContain('you')

    const continued: GroupedTurn = { ...grouped({ role: 'user', text: 'hi' }), showLabel: false }
    expect(mountTurn(continued).text()).not.toContain('you')
  })
})

describe('visual weight', () => {
  it('cards the user input and the answer, but not process narration', () => {
    // De-emphasis of narration comes from not being carded — the text itself
    // stays readable.
    const user = mountTurn(grouped({ role: 'user', text: 'hi' }))
    expect(user.find('.bg-elevated').exists()).toBe(true)

    const answer = mountTurn(grouped({ role: 'assistant', text: 'the answer' }))
    expect(answer.find('.bg-elevated').exists()).toBe(true)

    const process: GroupedTurn = { ...grouped({ role: 'assistant', text: 'looking…' }), isAnswer: false }
    expect(mountTurn(process).find('.bg-elevated').exists()).toBe(false)
  })

  it('shows a cursor while streaming', () => {
    const w = mountTurn(grouped({ role: 'assistant', text: 'partial', streaming: true }))
    expect(w.find('.animate-pulse').text()).toBe('▋')
  })

  it('renders an empty turn that is still streaming', () => {
    // The first token can lag; the turn must not collapse to nothing meanwhile.
    const w = mountTurn(grouped({ role: 'assistant', text: '', streaming: true }))
    expect(w.find('.animate-pulse').exists()).toBe(true)
  })
})

describe('tool calls and citations', () => {
  const toolCall: ToolInvocation = {
    id: 'c1',
    name: 'read_file',
    summary: 'Read x.ts',
    status: 'awaiting',
  }

  it('forwards an approval decision up from a nested tool row', () => {
    const w = mountTurn(grouped({ role: 'assistant', text: '', toolCalls: [toolCall] }))
    w.findAll('button')[0].trigger('click')
    expect(w.emitted('approve')).toEqual([['c1', 'allow']])
  })

  it('renders citation chips and emits the one clicked', async () => {
    const citation = {
      relative: 'src/services/crucible.ts',
      lineStart: 42,
      lineEnd: 50,
      language: 'ts',
      distance: 0.2,
    }
    const w = mountTurn(grouped({ role: 'assistant', text: 'answer', citations: [citation] }))

    const chip = w.findAll('button').at(-1)!
    expect(chip.text()).toBe('crucible.ts:42')
    await chip.trigger('click')
    expect(w.emitted('openCitation')).toEqual([[citation]])
  })

  it('shows a turn error without discarding the prose', () => {
    // A failed stream keeps whatever the user already read.
    const w = mountTurn(grouped({ role: 'assistant', text: 'partial', error: 'stream failed' }))
    expect(w.find('.text-red').text()).toBe('stream failed')
    expect(w.findComponent(MarkdownText).props('text')).toBe('partial')
  })
})
