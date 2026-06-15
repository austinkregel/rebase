import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/services/fileService', () => ({
  fileService: {
    list: vi.fn(async () => []),
    write: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    read: vi.fn(async () => ''),
  },
}))
vi.mock('@/stores/git', () => ({ useGitStore: () => ({ refresh: vi.fn() }) }))
vi.mock('@/stores/projects', () => ({ useProjectsStore: () => ({ active: null }) }))

import { useFilesStore } from './files'

describe('files store — single browse root (File explorer)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('setBrowseRoot normalizes the path and rootPath aliases it', () => {
    const files = useFilesStore()
    files.setBrowseRoot('/srv/app/')
    expect(files.browseRoot).toBe('/srv/app')
    expect(files.rootPath).toBe('/srv/app')
  })

  it('keeps bare roots intact', () => {
    const files = useFilesStore()
    files.setBrowseRoot('/')
    expect(files.browseRoot).toBe('/')
    files.setBrowseRoot('C:\\')
    expect(files.browseRoot).toBe('C:\\')
  })

  it('reset clears tree/expanded/open files but leaves browseRoot to the caller', () => {
    const files = useFilesStore()
    files.setBrowseRoot('/srv/app')
    files.tree['/srv/app'] = []
    files.expanded.add('/srv/app')
    files.reset()
    expect(Object.keys(files.tree)).toHaveLength(0)
    expect(files.expanded.size).toBe(0)
    expect(files.openFiles).toHaveLength(0)
  })

  it('toggleDir records the expanded path under its client', async () => {
    const files = useFilesStore()
    await files.toggleDir('c1', '/srv/app')
    expect(files.expandedByClient['c1']).toEqual(['/srv/app'])
    await files.toggleDir('c1', '/srv/app') // collapse
    expect(files.expandedByClient['c1']).toEqual([])
  })

  it('restore rehydrates a server’s expanded tree and re-fetches listings', async () => {
    const files = useFilesStore()
    files.expandedByClient['c2'] = ['/srv/a', '/srv/b']
    await files.restore('c2')
    expect([...files.expanded].sort()).toEqual(['/srv/a', '/srv/b'])
    // Listings were re-read (not persisted) — both dirs now have an entry array.
    expect(files.tree['/srv/a']).toBeDefined()
    expect(files.tree['/srv/b']).toBeDefined()
  })
})
