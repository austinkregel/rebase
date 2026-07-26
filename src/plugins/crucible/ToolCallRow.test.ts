import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ToolInvocation } from '@/services/crucibleState'
import ToolCallRow from './ToolCallRow.vue'

function call(partial: Partial<ToolInvocation> = {}): ToolInvocation {
  return { id: 'c1', name: 'read_file', summary: 'Read x.ts', status: 'done', ...partial }
}

const mountRow = (c: ToolInvocation) => mount(ToolCallRow, { props: { call: c } })

describe('awaiting approval', () => {
  it('renders a bordered attention card with all three choices', () => {
    // Approval is the only blocking interaction in the product; it must never
    // be quiet, and every option must be reachable without expanding anything.
    const w = mountRow(call({ name: 'write_file', summary: 'Write a.ts', status: 'awaiting' }))
    expect(w.find('.border-accent\\/40').exists()).toBe(true)

    const labels = w.findAll('button').map((b) => b.text())
    expect(labels).toEqual(['Allow', 'Allow & remember', 'Deny'])
  })

  it('emits the decision that was clicked', async () => {
    const w = mountRow(call({ status: 'awaiting' }))
    const buttons = w.findAll('button')

    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    await buttons[2].trigger('click')

    expect(w.emitted('approve')).toEqual([
      ['c1', 'allow'],
      ['c1', 'always'],
      ['c1', 'deny'],
    ])
  })

  it('shows the pending diff without needing a click', async () => {
    // The diff is what the user is being asked to approve — hiding it behind a
    // disclosure would invite blind approval.
    const w = mountRow(call({ status: 'awaiting', diff: '--- a\n+++ b\n@@ -1 +1 @@\n+added\n-removed' }))
    expect(w.find('pre').exists()).toBe(true)

    // Every line is tinted by its prefix, headers included — `+++ b` is green
    // for the same reason `+added` is.
    const lines = w.findAll('pre span').map((s) => [s.text(), s.classes().join(' ')])
    expect(lines).toEqual([
      ['--- a', 'block text-red'],
      ['+++ b', 'block text-green'],
      ['@@ -1 +1 @@', 'block text-accent'],
      ['+added', 'block text-green'],
      ['-removed', 'block text-red'],
    ])
  })
})

describe('failures', () => {
  it('shows the error inline, tinted red, with no approval buttons', () => {
    const w = mountRow(call({ status: 'error', error: 'file not found' }))
    expect(w.find('.border-red\\/40').exists()).toBe(true)
    expect(w.text()).toContain('file not found')
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('renders a denial as attention, not as quiet history', () => {
    const w = mountRow(call({ status: 'denied' }))
    expect(w.find('.border-red\\/40').exists()).toBe(true)
  })
})

describe('finished work', () => {
  it('hides output behind a collapsed disclosure', () => {
    const w = mountRow(call({ status: 'done', output: 'line one' }))
    const details = w.find('details')
    expect(details.exists()).toBe(true)
    expect(details.attributes('open')).toBeUndefined()
    expect(w.find('summary').text()).toBe('Read x.ts')
    expect(w.text()).toContain('line one')
  })

  it('lets a read-only tool recede but keeps a mutating one legible', () => {
    const read = mountRow(call({ name: 'read_file', status: 'done', output: 'x' }))
    expect(read.find('details').classes()).toContain('text-subtle')

    const write = mountRow(call({ name: 'write_file', status: 'done', output: 'x' }))
    expect(write.find('details').classes()).toContain('text-fg')
  })
})

describe('quiet rows', () => {
  it('spins only while the tool is in flight', () => {
    const running = mountRow(call({ status: 'running' }))
    expect(running.find('.animate-spin').exists()).toBe(true)
    expect(running.find('details').exists()).toBe(false)

    const done = mountRow(call({ status: 'done' }))
    expect(done.find('.animate-spin').exists()).toBe(false)
  })

  it('falls back to a one-liner when there is nothing to show', () => {
    const w = mountRow(call({ status: 'done' }))
    expect(w.find('details').exists()).toBe(false)
    expect(w.text()).toBe('Read x.ts')
  })
})
