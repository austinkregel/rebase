import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const saved: Record<string, unknown> = {}
vi.mock('@/services/store', () => ({
  loadValue: vi.fn(async (key: string, fallback: unknown) => saved[key] ?? fallback),
  saveValue: vi.fn(async (key: string, value: unknown) => {
    saved[key] = JSON.parse(JSON.stringify(value))
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
})
