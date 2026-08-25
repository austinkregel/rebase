import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate, _resetUpdater, type UpdaterDeps, type UpdateHandle } from './updater'

function handle(over: Partial<UpdateHandle> = {}): UpdateHandle {
  return {
    version: '1.2.0',
    currentVersion: '1.1.0',
    downloadAndInstall: vi.fn(async () => {}),
    ...over,
  }
}

function deps(over: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    check: vi.fn(async () => null),
    relaunch: vi.fn(async () => {}),
    isTauri: () => true,
    confirm: vi.fn(async () => true) as unknown as UpdaterDeps['confirm'],
    notify: Object.assign(vi.fn(), {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    }) as unknown as UpdaterDeps['notify'],
    ...over,
  }
}

describe('updater', () => {
  beforeEach(() => _resetUpdater())

  it('does nothing in the browser build', async () => {
    const d = deps({ isTauri: () => false })
    expect(await checkForUpdate(d)).toBe('skipped-not-desktop')
    expect(d.check).not.toHaveBeenCalled()
  })

  it('checks once per launch, not once per call', async () => {
    const d = deps()
    await checkForUpdate(d)
    expect(await checkForUpdate(d)).toBe('skipped-already-checked')
    // The point: a remount must not re-prompt someone who already declined.
    expect(d.check).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when already current', async () => {
    const d = deps({ check: vi.fn(async () => null) })
    expect(await checkForUpdate(d)).toBe('up-to-date')
    expect(d.confirm).not.toHaveBeenCalled()
  })

  it('never installs without asking first', async () => {
    const h = handle()
    const d = deps({ check: vi.fn(async () => h), confirm: vi.fn(async () => false) as never })
    expect(await checkForUpdate(d)).toBe('declined')
    expect(h.downloadAndInstall).not.toHaveBeenCalled()
    expect(d.relaunch).not.toHaveBeenCalled()
  })

  it('installs and relaunches once accepted', async () => {
    const h = handle()
    const d = deps({ check: vi.fn(async () => h) })
    expect(await checkForUpdate(d)).toBe('installing')
    expect(h.downloadAndInstall).toHaveBeenCalledOnce()
    expect(d.relaunch).toHaveBeenCalledOnce()
  })

  it('names both versions in the prompt', async () => {
    const d = deps({ check: vi.fn(async () => handle({ version: '2.0.0', currentVersion: '1.9.3' })) })
    await checkForUpdate(d)
    const arg = vi.mocked(d.confirm).mock.calls[0][0] as { title: string; message: string }
    expect(arg.title).toContain('2.0.0')
    expect(arg.message).toContain('1.9.3')
  })

  it('swallows a failed check instead of exploding during boot', async () => {
    const d = deps({
      check: vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND github.com')
      }),
    })
    // Offline is the common case, the user did not ask, and they can do nothing
    // about it — so no toast.
    await expect(checkForUpdate(d)).resolves.toBe('failed')
    expect(d.notify.error).not.toHaveBeenCalled()
  })

  it('surfaces a failed install, because the user is waiting on it', async () => {
    const h = handle({
      downloadAndInstall: vi.fn(async () => {
        throw new Error('disk full')
      }),
    })
    const d = deps({ check: vi.fn(async () => h) })
    expect(await checkForUpdate(d)).toBe('failed')
    expect(d.notify.error).toHaveBeenCalled()
    expect(d.relaunch).not.toHaveBeenCalled()
  })

  it('treats a failed relaunch as installed, not as lost', async () => {
    const d = deps({
      check: vi.fn(async () => handle()),
      relaunch: vi.fn(async () => {
        throw new Error('nope')
      }),
    })
    expect(await checkForUpdate(d)).toBe('installing')
    // It is on disk and applies next launch — warn, don't cry failure.
    expect(d.notify.warning).toHaveBeenCalled()
    expect(d.notify.error).not.toHaveBeenCalled()
  })
})
