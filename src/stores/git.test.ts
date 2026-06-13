import { describe, it, expect } from 'vitest'
import { parseGitStatus } from './git'

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
