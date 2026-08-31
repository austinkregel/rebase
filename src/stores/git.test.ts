import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const exec = vi.fn()
vi.mock('@/services/fileService', () => ({ fileService: { exec: (...a: unknown[]) => exec(...a) } }))

import { parseGitStatus, useGitStore } from './git'

describe('parseGitStatus', () => {
  it('reads branch + dirty count from porcelain --branch output', () => {
    const out = '## main...origin/main [ahead 1]\n M src/a.ts\n?? new.txt\nA  staged.ts\n'
    expect(parseGitStatus(out)).toEqual({ branch: 'main', dirty: 3 })
  })

  it('clean tree → zero dirty', () => {
    expect(parseGitStatus('## main...origin/main\n')).toEqual({ branch: 'main', dirty: 0 })
  })

  it('branch with no upstream', () => {
    expect(parseGitStatus('## feature/x\n M a\n')).toEqual({ branch: 'feature/x', dirty: 1 })
  })

  it('detached HEAD', () => {
    expect(parseGitStatus('## HEAD (no branch)\n M a\n').branch).toBe('detached')
  })

  it('no commits yet', () => {
    expect(parseGitStatus('## No commits yet on main\n?? a\n')).toEqual({ branch: 'main', dirty: 1 })
  })

  it('empty output', () => {
    expect(parseGitStatus('')).toEqual({ branch: '', dirty: 0 })
  })
})

describe('useGitStore loading (per-client)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    exec.mockReset()
  })

  it('tracks loading per clientId and clears it when a refresh settles', async () => {
    const git = useGitStore()
    let release!: () => void
    exec.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ code: 0, stdout: '## main\n' })
      }),
    )

    const p = git.refresh('server-a', '/repo')
    expect(git.isLoading('server-a')).toBe(true)
    // A different, idle server is unaffected by server-a's in-flight refresh.
    expect(git.isLoading('server-b')).toBe(false)

    release()
    await p
    expect(git.isLoading('server-a')).toBe(false)
    expect(git.statusFor('server-a')).toEqual({ branch: 'main', dirty: 0 })
  })

  it('isLoading is false for null / unknown clients', () => {
    const git = useGitStore()
    expect(git.isLoading(null)).toBe(false)
    expect(git.isLoading('never-seen')).toBe(false)
  })
})
