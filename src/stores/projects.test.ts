import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const saved: Record<string, unknown> = {}
vi.mock('@/services/store', () => ({
  loadValue: vi.fn(async (key: string, fallback: unknown) => saved[key] ?? fallback),
  saveValue: vi.fn(async (key: string, value: unknown) => {
    saved[key] = JSON.parse(JSON.stringify(value))
  }),
  removeValue: vi.fn(async (key: string) => {
    delete saved[key]
  }),
}))
// Avoid pulling the real session/git stores (and their deps) into the test.
vi.mock('./session', () => ({ useSessionStore: () => ({ selectAgent: vi.fn() }) }))
vi.mock('./git', () => ({ useGitStore: () => ({ refresh: vi.fn() }) }))

import { useProjectsStore } from './projects'

describe('projects store — multi-root', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const k of Object.keys(saved)) delete saved[k]
  })

  it('creates a multi-root project and exposes the primary root', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({
      name: 'app',
      controlPlane: 'kratos',
      clientId: 'node-1',
      rootPaths: ['/srv/app/', '/srv/lib'],
    })
    expect(p.rootPaths).toEqual(['/srv/app', '/srv/lib']) // normalized
    projects.activeId = p.id
    expect(projects.primaryRoot).toBe('/srv/app')
  })

  it('addRoot appends + dedupes; removeRoot drops', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    await projects.addRoot(p.id, '/b/')
    await projects.addRoot(p.id, '/b') // duplicate after normalize
    expect(p.rootPaths).toEqual(['/a', '/b'])
    await projects.removeRoot(p.id, '/a')
    expect(p.rootPaths).toEqual(['/b'])
  })

  it('migrates a legacy single-root project (rootPath) on load', async () => {
    saved['projects'] = [
      { id: '1', name: 'old', controlPlane: null, clientId: 'n', rootPath: '/legacy/', createdAt: 1 },
    ]
    const projects = useProjectsStore()
    await projects.load()
    expect(projects.projects[0].rootPaths).toEqual(['/legacy'])
  })

  it('persists across instances', async () => {
    const projects = useProjectsStore()
    await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a', '/b'] })
    setActivePinia(createPinia())
    const fresh = useProjectsStore()
    await fresh.load()
    expect(fresh.projects[0].rootPaths).toEqual(['/a', '/b'])
  })

  it('restores the open + expanded projects across a reload', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    projects.setExpanded(p.id, true)
    projects.open(p.id)

    setActivePinia(createPinia())
    const fresh = useProjectsStore()
    await fresh.load()
    expect(fresh.activeId).toBe(p.id)
    expect(fresh.expandedIds.has(p.id)).toBe(true)
  })

  it('drops UI state for projects that no longer exist', async () => {
    saved['projects'] = []
    saved['projects-ui'] = { activeId: 'gone', expandedIds: ['gone'] }
    const projects = useProjectsStore()
    await projects.load()
    expect(projects.activeId).toBeNull()
    expect(projects.expandedIds.size).toBe(0)
  })

  it('retires the dead "workspaces" key on load', async () => {
    saved['workspaces'] = { legion: ['C:\\'] }
    saved['projects'] = []
    await useProjectsStore().load()
    expect(saved['workspaces']).toBeUndefined()
  })

  it('moveToServer repoints a project without touching its roots', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({
      name: 'rebase',
      controlPlane: null,
      clientId: 'Mnemosyne',
      rootPaths: ['/Users/a/src/rebase', '/Users/a/src/rebase-indexer'],
    })
    await projects.moveToServer(p.id, 'mnemosyne')
    expect(projects.projects[0].clientId).toBe('mnemosyne')
    // Roots are paths on the machine, not handles to it — they survive as-is.
    expect(projects.projects[0].rootPaths).toEqual([
      '/Users/a/src/rebase',
      '/Users/a/src/rebase-indexer',
    ])
    // And it is persisted, not just live state.
    expect((saved['projects'] as { clientId: string }[])[0].clientId).toBe('mnemosyne')
  })

  it('moveToServer ignores an unknown project or a no-op move', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'c1', rootPaths: ['/a'] })
    await projects.moveToServer('nope', 'c2')
    await projects.moveToServer(p.id, '')
    await projects.moveToServer(p.id, 'c1')
    expect(projects.projects[0].clientId).toBe('c1')
  })
})

describe('projects store — project (IDE) mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const k of Object.keys(saved)) delete saved[k]
  })

  it('enter opens the project and turns the mode on; exit keeps it open', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    projects.enterProjectMode(p.id)
    expect(projects.inProjectMode).toBe(true)
    expect(projects.focused?.id).toBe(p.id)
    expect(projects.activeId).toBe(p.id) // entering implies opening

    projects.exitProjectMode()
    expect(projects.inProjectMode).toBe(false)
    expect(projects.focused).toBeNull()
    expect(projects.activeId).toBe(p.id) // still open for a look
  })

  it('enter ignores an unknown id', () => {
    const projects = useProjectsStore()
    projects.enterProjectMode('nope')
    expect(projects.inProjectMode).toBe(false)
  })

  it('toggle enters the active project, then exits it', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    projects.open(p.id) // sets activeId without focusing
    projects.toggleProjectMode()
    expect(projects.focused?.id).toBe(p.id)
    projects.toggleProjectMode()
    expect(projects.inProjectMode).toBe(false)
  })

  it('toggle with a different id switches focus rather than exiting', async () => {
    const projects = useProjectsStore()
    const a = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    const b = await projects.create({ name: 'b', controlPlane: null, clientId: 'n', rootPaths: ['/b'] })
    projects.enterProjectMode(a.id)
    projects.toggleProjectMode(b.id)
    expect(projects.focused?.id).toBe(b.id)
  })

  it('persists focusedId across a reload, dropping it if the project is gone', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    projects.enterProjectMode(p.id)

    setActivePinia(createPinia())
    const fresh = useProjectsStore()
    await fresh.load()
    expect(fresh.focusedId).toBe(p.id)
    expect(fresh.inProjectMode).toBe(true)

    // Now simulate the project having been deleted out from under a stale UI blob.
    saved['projects'] = []
    setActivePinia(createPinia())
    const gone = useProjectsStore()
    await gone.load()
    expect(gone.focusedId).toBeNull()
  })

  it('deleting the focused project drops the mode', async () => {
    const projects = useProjectsStore()
    const p = await projects.create({ name: 'a', controlPlane: null, clientId: 'n', rootPaths: ['/a'] })
    projects.enterProjectMode(p.id)
    await projects.remove(p.id)
    expect(projects.inProjectMode).toBe(false)
    expect(projects.focusedId).toBeNull()
  })
})
