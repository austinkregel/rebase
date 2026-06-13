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
})
