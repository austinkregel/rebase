import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyAppearance,
  paletteFor,
  clampScale,
  themePresets,
  defaultAppearance,
} from './appearance'

describe('appearance', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('clamps UI scale to the supported range', () => {
    expect(clampScale(0.5)).toBe(0.8)
    expect(clampScale(3)).toBe(1.5)
    expect(clampScale(1.1)).toBe(1.1)
    expect(clampScale(NaN)).toBe(1)
  })

  it('overlays the accent on the chosen preset', () => {
    const palette = paletteFor({ theme: 'dim', accent: '#abcdef', uiScale: 1 })
    const dim = themePresets.find((p) => p.id === 'dim')!
    expect(palette.bg).toBe(dim.palette.bg)
    expect(palette.accent).toBe('#abcdef')
  })

  it('falls back to the first preset for an unknown theme', () => {
    const palette = paletteFor({ theme: 'nope', accent: '', uiScale: 1 })
    expect(palette.bg).toBe(themePresets[0].palette.bg)
    expect(palette.accent).toBe(themePresets[0].palette.accent)
  })

  it('writes both modern and legacy tokens plus zoom to the document root', () => {
    applyAppearance({ theme: 'midnight', accent: '#ff0000', uiScale: 1.25 })
    const root = document.documentElement
    expect(root.style.getPropertyValue('--color-accent')).toBe('#ff0000')
    expect(root.style.getPropertyValue('--accent')).toBe('#ff0000')
    expect(root.style.getPropertyValue('--color-bg')).toBe(themePresets[0].palette.bg)
    expect(root.style.getPropertyValue('--bg')).toBe(themePresets[0].palette.bg)
    expect(root.style.getPropertyValue('zoom')).toBe('1.25')
  })

  it('clamps an out-of-range scale when applying', () => {
    applyAppearance({ ...defaultAppearance, uiScale: 5 })
    expect(document.documentElement.style.getPropertyValue('zoom')).toBe('1.5')
  })
})
