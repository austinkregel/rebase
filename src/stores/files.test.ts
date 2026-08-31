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
    // openFile now classifies via fileContent.resolveOpen: stat (unknown here)
    // then readBytes → empty bytes sniff as clean/editable text.
    stat: vi.fn(async () => null),
    readBytes: vi.fn(async () => new Uint8Array()),
  },
}))
vi.mock('@/stores/git', () => ({ useGitStore: () => ({ refresh: vi.fn() }) }))
vi.mock('@/stores/projects', () => ({ useProjectsStore: () => ({ active: null }) }))

import { fileService } from '@/services/fileService'
import { useFilesStore } from './files'
import { useAgentsStore } from './agents'

/** Mark agents as connected the way an open socket + `client_list` frame would. */
function listClients(...clientIds: string[]) {
  const agents = useAgentsStore()
  agents.onSocketStatus('open')
  agents.agents = clientIds.map((clientId) => ({ clientId, authenticated: true })) as never
  agents._clientListReceived = true
}

describe('files store — single browse root (File explorer)', () => {
  // These cover tree/expansion mechanics, not reachability. Open the socket so
  // every agent reads as online (the optimistic window) and stays out of the way.
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentsStore().onSocketStatus('open')
  })

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

  it('reset clears listings and open files but keeps the expanded shape', () => {
    const files = useFilesStore()
    files.setBrowseRoot('/srv/app')
    files.tree['c1'] = { '/srv/app': [] }
    files.expandedSet('c1').add('/srv/app')
    files.reset()
    expect(Object.keys(files.tree)).toHaveLength(0)
    expect(files.openFiles).toHaveLength(0)
    // Kept — it is the persisted state that restore() re-fetches on reconnect.
    expect(files.isExpanded('c1', '/srv/app')).toBe(true)
  })

  it('closeAllFiles keeps cached listings so other servers’ trees survive', async () => {
    const files = useFilesStore()
    await files.toggleDir('c1', '/srv/app')
    files.openFiles.push({
      path: '/srv/app/a.ts',
      clientId: 'c1',
      content: '',
      savedContent: '',
      loading: false,
      error: null,
    })
    files.closeAllFiles()
    expect(files.openFiles).toHaveLength(0)
    expect(files.entriesFor('c1', '/srv/app')).toBeDefined()
    expect(files.isExpanded('c1', '/srv/app')).toBe(true)
  })

  it('toggleDir records the expanded path under its client', async () => {
    const files = useFilesStore()
    await files.toggleDir('c1', '/srv/app')
    expect([...files.expandedSet('c1')]).toEqual(['/srv/app'])
    await files.toggleDir('c1', '/srv/app') // collapse
    expect([...files.expandedSet('c1')]).toEqual([])
  })

  it('keeps listings and expansion separate per client', async () => {
    const files = useFilesStore()
    await files.toggleDir('c1', '/srv/app')
    expect(files.isExpanded('c1', '/srv/app')).toBe(true)
    // Same path on a different server is its own, independent entry.
    expect(files.isExpanded('c2', '/srv/app')).toBe(false)
    expect(files.entriesFor('c2', '/srv/app')).toBeUndefined()
  })

  it('expand loads a directory flagged expanded but never listed', async () => {
    const files = useFilesStore()
    files.expandedSet('c1').add('/srv/app') // e.g. restored from a past session
    await files.expand('c1', '/srv/app')
    expect(files.entriesFor('c1', '/srv/app')).toBeDefined()
  })

  it('restore re-fetches the listings of a server’s expanded directories', async () => {
    const files = useFilesStore()
    files.expanded['c2'] = new Set(['/srv/a', '/srv/b'])
    await files.restore('c2')
    expect([...files.expandedSet('c2')].sort()).toEqual(['/srv/a', '/srv/b'])
    // Listings were re-read (not persisted) — both dirs now have an entry array.
    expect(files.entriesFor('c2', '/srv/a')).toBeDefined()
    expect(files.entriesFor('c2', '/srv/b')).toBeDefined()
  })
})

describe('files store — offline agents', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(fileService.list).mockClear()
  })

  it('lists optimistically once the socket is up but client_list has not landed', async () => {
    // The list is empty in that window; refusing there would fail every
    // restored listing on a perfectly healthy connection.
    useAgentsStore().onSocketStatus('open')
    const files = useFilesStore()
    await files.loadDir('c1', '/srv/app')
    expect(fileService.list).toHaveBeenCalledWith('c1', '/srv/app')
  })

  it('refuses every server while the control-plane socket is down', async () => {
    // No socket, no optimism: at launch nothing has connected yet, and sending
    // anyway buys the caller a 20s timeout instead of an answer.
    const files = useFilesStore()
    await expect(files.loadDir('c1', '/srv/app')).rejects.toThrow('c1 is offline')
    expect(fileService.list).not.toHaveBeenCalled()
  })

  it('stops trusting a client_list once the socket drops', async () => {
    listClients('c1')
    const files = useFilesStore()
    await files.loadDir('c1', '/srv/app')
    expect(fileService.list).toHaveBeenCalledTimes(1)
    // The agent was listed a moment ago, but the list arrived over a socket
    // that is now gone — it describes servers we can no longer address.
    useAgentsStore().onSocketStatus('closed')
    await expect(files.loadDir('c1', '/srv/app')).rejects.toThrow('c1 is offline')
    expect(fileService.list).toHaveBeenCalledTimes(1)
  })

  it('refuses to address a server the control plane is not listing', async () => {
    listClients('c1')
    const files = useFilesStore()
    await expect(files.loadDir('c2', '/srv/app')).rejects.toThrow('c2 is offline')
    // The point of the guard: no request goes out to hang for 20s.
    expect(fileService.list).not.toHaveBeenCalled()
  })

  it('names the server by hostname when the control plane reported one', async () => {
    const agents = useAgentsStore()
    agents.agents = [{ clientId: 'c9', hostname: 'kratos', authenticated: false }] as never
    agents._clientListReceived = true
    const files = useFilesStore()
    await expect(files.loadDir('c9', '/srv/app')).rejects.toThrow('kratos is offline')
  })

  it('expand leaves a previously-expanded path alone when the server is down', async () => {
    listClients('c1')
    const files = useFilesStore()
    files.expandedSet('c2').add('/srv/app')
    await expect(files.expand('c2', '/srv/app')).rejects.toThrow('c2 is offline')
    // Still expanded: the shape is persisted state, and the server being down
    // says nothing about whether the directory exists.
    expect(files.isExpanded('c2', '/srv/app')).toBe(true)
  })

  it('restore keeps the persisted tree shape instead of pruning it', async () => {
    listClients('c1')
    const files = useFilesStore()
    files.expanded['c2'] = new Set(['/srv/a', '/srv/b'])
    await files.restore('c2')
    expect([...files.expandedSet('c2')].sort()).toEqual(['/srv/a', '/srv/b'])
    expect(fileService.list).not.toHaveBeenCalled()
  })
})

describe('files store — open-file identity is per (server, path) (H3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentsStore().onSocketStatus('open')
    vi.clearAllMocks()
  })

  it('opens the same path on two servers as two independent buffers', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/proj/README.md')
    await files.openFile('c2', '/proj/README.md')
    expect(files.openFiles).toHaveLength(2)
    // Active is the most-recently opened server's file, not a collided one.
    expect(files.activeFile?.clientId).toBe('c2')
    expect(files.isActive('c2', '/proj/README.md')).toBe(true)
    expect(files.isActive('c1', '/proj/README.md')).toBe(false)
  })

  it('re-opening an already-open (server, path) just activates it', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/a.ts')
    await files.openFile('c2', '/a.ts')
    await files.openFile('c1', '/a.ts')
    expect(files.openFiles).toHaveLength(2)
    expect(files.activeFile?.clientId).toBe('c1')
  })

  it('edits and saves target the addressed server only', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/a.ts')
    await files.openFile('c2', '/a.ts')
    files.updateContent('c1', '/a.ts', 'from c1')
    files.updateContent('c2', '/a.ts', 'from c2')
    expect(files.openFiles.find((f) => f.clientId === 'c1')?.content).toBe('from c1')
    expect(files.openFiles.find((f) => f.clientId === 'c2')?.content).toBe('from c2')
    await files.saveFile('c2', '/a.ts')
    expect(fileService.write).toHaveBeenCalledExactlyOnceWith('c2', '/a.ts', 'from c2')
  })

  it('closeFile closes only the matching server’s buffer', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/a.ts')
    await files.openFile('c2', '/a.ts')
    files.closeFile('c1', '/a.ts')
    expect(files.openFiles).toHaveLength(1)
    expect(files.openFiles[0].clientId).toBe('c2')
  })
})

describe('files store — content classification gates editing (hazard fix)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentsStore().onSocketStatus('open')
    vi.clearAllMocks()
  })

  it('a binary file opens read-only hex and never fills the buffer with decoded bytes', async () => {
    vi.mocked(fileService.readBytes).mockResolvedValueOnce(new Uint8Array([0x00, 0x01, 0x02, 0x03]))
    const files = useFilesStore()
    await files.openFile('c1', '/a.bin')
    expect(files.openFiles[0]).toMatchObject({ kind: 'binary-hex', editable: false, content: '' })
  })

  it('saveFile refuses a non-editable buffer even after an edit', async () => {
    vi.mocked(fileService.readBytes).mockResolvedValueOnce(new Uint8Array([0x00, 0x01]))
    const files = useFilesStore()
    await files.openFile('c1', '/a.bin')
    files.updateContent('c1', '/a.bin', 'evil')
    await files.saveFile('c1', '/a.bin')
    expect(fileService.write).not.toHaveBeenCalled()
  })

  it('a clean text file is editable and its content loads', async () => {
    vi.mocked(fileService.readBytes).mockResolvedValueOnce(new TextEncoder().encode('hello'))
    const files = useFilesStore()
    await files.openFile('c1', '/a.txt')
    expect(files.openFiles[0]).toMatchObject({ kind: 'text', editable: true, content: 'hello' })
  })
})

describe('files store — directory rename/remove remaps descendants (M6)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAgentsStore().onSocketStatus('open')
    vi.clearAllMocks()
  })

  it('renaming a directory remaps open child buffers, the active key, and expanded dirs', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/a/x.ts')
    await files.openFile('c1', '/a/sub/y.ts') // becomes active
    files.expandedSet('c1').add('/a/sub')
    await files.renameEntry('c1', '/a', '/b', ['/'])
    expect(files.openFiles.map((f) => f.path).sort()).toEqual(['/b/sub/y.ts', '/b/x.ts'])
    expect(files.isActive('c1', '/b/sub/y.ts')).toBe(true)
    expect([...files.expandedSet('c1')]).toContain('/b/sub')
    expect([...files.expandedSet('c1')]).not.toContain('/a/sub')
  })

  it('rename does not touch a same-path buffer on another server', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/a/x.ts')
    await files.openFile('c2', '/a/x.ts')
    await files.renameEntry('c1', '/a', '/b', ['/'])
    expect(files.isOpen('c1', '/b/x.ts')).toBe(true)
    expect(files.isOpen('c2', '/a/x.ts')).toBe(true)
  })

  it('removing a directory closes buffers beneath it and collapses descendants', async () => {
    const files = useFilesStore()
    await files.openFile('c1', '/a/x.ts')
    await files.openFile('c1', '/a/sub/y.ts')
    await files.openFile('c1', '/keep.ts')
    files.expandedSet('c1').add('/a/sub')
    await files.removeEntry('c1', '/a', true, '/')
    expect(files.openFiles.map((f) => f.path)).toEqual(['/keep.ts'])
    expect([...files.expandedSet('c1')]).not.toContain('/a/sub')
  })
})
