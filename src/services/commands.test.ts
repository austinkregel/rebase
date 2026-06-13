import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allCommands,
  closePalette,
  openPalette,
  palette,
  registerCommand,
  registerCommands,
  runCommand,
  togglePalette,
} from './commands'

afterEach(() => {
  // Clear any commands left registered by a test.
  for (const c of allCommands()) registerCommand(c)() // re-register then dispose = remove
  closePalette()
})

describe('command registry', () => {
  it('registers, lists, and runs a command', async () => {
    const run = vi.fn()
    const dispose = registerCommand({ id: 'test.run', title: 'Run', run })
    expect(allCommands().some((c) => c.id === 'test.run')).toBe(true)
    await runCommand('test.run')
    expect(run).toHaveBeenCalledOnce()
    dispose()
    expect(allCommands().some((c) => c.id === 'test.run')).toBe(false)
  })

  it('does not run a disabled command', async () => {
    const run = vi.fn()
    const dispose = registerCommand({ id: 'test.disabled', title: 'X', isEnabled: () => false, run })
    await runCommand('test.disabled')
    expect(run).not.toHaveBeenCalled()
    dispose()
  })

  it('runCommand on an unknown id is a no-op', async () => {
    await expect(runCommand('nope')).resolves.toBeUndefined()
  })

  it('registerCommands disposes all at once', () => {
    const dispose = registerCommands([
      { id: 'a', title: 'A', run: () => {} },
      { id: 'b', title: 'B', run: () => {} },
    ])
    expect(allCommands().filter((c) => c.id === 'a' || c.id === 'b')).toHaveLength(2)
    dispose()
    expect(allCommands().filter((c) => c.id === 'a' || c.id === 'b')).toHaveLength(0)
  })

  it('toggles palette open state', () => {
    expect(palette.open).toBe(false)
    openPalette()
    expect(palette.open).toBe(true)
    togglePalette()
    expect(palette.open).toBe(false)
  })
})
