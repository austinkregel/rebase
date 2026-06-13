import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleKeydown, isMac, keybindingHint } from './keybindings'
import { palette, registerCommand, closePalette } from './commands'

afterEach(() => closePalette())

// In jsdom, isMac is false, so "mod" resolves to Ctrl.
function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { ...init, cancelable: true })
}

describe('keybindingHint', () => {
  it('formats a binding and returns empty for unknown commands', () => {
    expect(keybindingHint('__palette')).toMatch(isMac ? /⇧.*P|⌘/ : /Shift\+P/)
    expect(keybindingHint('does.not.exist')).toBe('')
  })
})

describe('handleKeydown', () => {
  it('toggles the palette on mod+shift+p', () => {
    expect(palette.open).toBe(false)
    handleKeydown(key({ key: 'p', ctrlKey: !isMac, metaKey: isMac, shiftKey: true }))
    expect(palette.open).toBe(true)
  })

  it('dispatches a bound command', () => {
    const run = vi.fn()
    const dispose = registerCommand({ id: 'view.toggleServers', title: 'Toggle', run })
    handleKeydown(key({ key: 'b', ctrlKey: !isMac, metaKey: isMac }))
    expect(run).toHaveBeenCalledOnce()
    dispose()
  })

  it('ignores unbound chords', () => {
    const e = key({ key: 'q', ctrlKey: !isMac, metaKey: isMac })
    const spy = vi.spyOn(e, 'preventDefault')
    handleKeydown(e)
    expect(spy).not.toHaveBeenCalled()
  })

  it('skips editor-owned chords (mod+s) when focus is in a CodeMirror editor', () => {
    const run = vi.fn()
    const dispose = registerCommand({ id: 'file.saveActive', title: 'Save', run })
    const host = document.createElement('div')
    host.className = 'cm-editor'
    const inner = document.createElement('div')
    host.appendChild(inner)
    document.body.appendChild(host)
    const e = key({ key: 's', ctrlKey: !isMac, metaKey: isMac })
    Object.defineProperty(e, 'target', { value: inner })
    handleKeydown(e)
    expect(run).not.toHaveBeenCalled() // CodeMirror handles it
    dispose()
    host.remove()
  })
})
