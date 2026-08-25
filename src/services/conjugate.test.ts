import { describe, it, expect } from 'vitest'
import { conjugate } from './conjugate'

describe('conjugate', () => {
  it('conjugates a simple verb through its tenses', () => {
    expect(conjugate('Save')).toEqual({
      idle: 'Save',
      pending: 'Saving…',
      success: 'Saved',
      error: 'Save failed',
    })
  })

  it('handles irregular verbs via morphology, not suffix rules', () => {
    expect(conjugate('Build index')).toMatchObject({
      pending: 'Building index…',
      success: 'Built index',
    })
    expect(conjugate('Run')).toMatchObject({ pending: 'Running…', success: 'Ran' })
  })

  it('conjugates only the verb and keeps the rest of the phrase in order', () => {
    expect(conjugate('Rebuild index')).toMatchObject({
      pending: 'Rebuilding index…',
      success: 'Rebuilt index',
    })
  })

  it('preserves the verb capitalization', () => {
    expect(conjugate('connect').pending).toBe('connecting…')
    expect(conjugate('Connect').pending).toBe('Connecting…')
  })

  it('lets callers override any state (e.g. object-fronted success)', () => {
    expect(conjugate('Build index', { success: 'Index built' })).toMatchObject({
      pending: 'Building index…',
      success: 'Index built',
    })
  })

  it('falls back to the untouched label when there is no verb', () => {
    expect(conjugate('Preferences')).toEqual({
      idle: 'Preferences',
      pending: 'Preferences…',
      success: 'Preferences',
      error: 'Preferences failed',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(conjugate('  Save  ').idle).toBe('Save')
  })
})
