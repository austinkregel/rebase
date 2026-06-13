import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerStatusItem, statusItems } from './statusBar'
import { menuItemsFor, registerMenuItem, type FileMenuContext } from './menus'
import { registerView, viewsFor } from './views'
import { allCommands } from './commands'
import { activatePlugins, deactivatePlugins, definePlugin } from './plugins'

afterEach(() => deactivatePlugins())

const Stub = { name: 'Stub', render: () => null }
const Icon = () => null

describe('statusBar registry', () => {
  it('filters by side + when, sorts by order', () => {
    const d1 = registerStatusItem({ id: 'a', side: 'right', order: 2, text: () => 'a' })
    const d2 = registerStatusItem({ id: 'b', side: 'right', order: 1, text: () => 'b' })
    const d3 = registerStatusItem({ id: 'c', side: 'left', text: () => 'c' })
    const d4 = registerStatusItem({ id: 'hidden', side: 'right', when: () => false, text: () => 'x' })
    expect(statusItems('right').map((i) => i.id)).toEqual(['b', 'a'])
    expect(statusItems('left').map((i) => i.id)).toEqual(['c'])
    ;[d1, d2, d3, d4].forEach((d) => d())
    expect(statusItems('right')).toHaveLength(0)
  })
})

describe('menus registry', () => {
  it('returns items for a location filtered by when(ctx), flattened + sorted', () => {
    const dispose = registerMenuItem<FileMenuContext>({
      id: 'dirs-only',
      menu: 'file/context',
      when: (c) => c.isDir,
      build: () => [{ label: 'Index Folder', action: () => {} }],
    })
    expect(menuItemsFor<FileMenuContext>('file/context', { clientId: 'n', path: '/a', name: 'a', isDir: true })).toHaveLength(1)
    expect(menuItemsFor<FileMenuContext>('file/context', { clientId: 'n', path: '/a.txt', name: 'a.txt', isDir: false })).toHaveLength(0)
    expect(menuItemsFor('server/context', {})).toHaveLength(0)
    dispose()
    expect(menuItemsFor<FileMenuContext>('file/context', { clientId: 'n', path: '/a', name: 'a', isDir: true })).toHaveLength(0)
  })
})

describe('views registry', () => {
  it('registers + disposes views by location', () => {
    const dispose = registerView({ id: 'projects', location: 'sidebar.project', title: 'Projects', icon: Icon, component: Stub })
    expect(viewsFor('sidebar.project').map((v) => v.id)).toEqual(['projects'])
    expect(viewsFor('sidebar.tools')).toHaveLength(0)
    dispose()
    expect(viewsFor('sidebar.project')).toHaveLength(0)
  })
})

describe('plugin host', () => {
  it('activate adds contributions (tagged with pluginId); deactivate removes them', async () => {
    const openTerminal = vi.fn()
    const plugin = definePlugin({
      id: 'demo',
      name: 'Demo',
      activate(ctx) {
        ctx.registerCommand({ id: 'demo.hi', title: 'Hi', run: () => {} })
        ctx.registerStatusItem({ id: 'demo.item', side: 'right', text: () => 'hi' })
        ctx.registerView({ id: 'demo.view', location: 'sidebar.tools', title: 'Demo', icon: Icon, component: Stub })
        ctx.host.openTerminal()
      },
    })

    await activatePlugins([plugin], { openTerminal })
    expect(openTerminal).toHaveBeenCalledOnce()
    const cmd = allCommands().find((c) => c.id === 'demo.hi')
    expect(cmd?.pluginId).toBe('demo')
    expect(statusItems('right').some((i) => i.id === 'demo.item')).toBe(true)
    expect(viewsFor('sidebar.tools').some((v) => v.id === 'demo.view')).toBe(true)

    deactivatePlugins()
    expect(allCommands().some((c) => c.id === 'demo.hi')).toBe(false)
    expect(statusItems('right').some((i) => i.id === 'demo.item')).toBe(false)
    expect(viewsFor('sidebar.tools').some((v) => v.id === 'demo.view')).toBe(false)
  })

  it('does not double-activate the same plugin id', async () => {
    let count = 0
    const plugin = definePlugin({ id: 'once', name: 'Once', activate: () => { count++ } })
    await activatePlugins([plugin], { openTerminal: () => {} })
    await activatePlugins([plugin], { openTerminal: () => {} })
    expect(count).toBe(1)
  })
})
