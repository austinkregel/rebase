import { defineStore } from 'pinia'
import { fileService } from '@/services/fileService'

export interface GitState {
  branch: string
  dirty: number
}

/** Command run client-side over the generic exec RPC to read git state. */
export const GIT_STATUS_COMMAND = 'git status --porcelain --branch'

/**
 * Parse `git status --porcelain --branch` output. The first `## ` line carries
 * the branch (or detached/no-commits state); every other non-empty line is a
 * changed entry.
 */
export function parseGitStatus(stdout: string): GitState {
  let branch = ''
  let dirty = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim()
      if (head.toLowerCase().startsWith('no commits yet on ')) {
        branch = head.slice('no commits yet on '.length).trim()
      } else if (head.startsWith('HEAD') || head.includes('(no branch)')) {
        branch = 'detached'
      } else {
        branch = head.split('...')[0].trim()
      }
    } else if (line.trim() !== '') {
      dirty++
    }
  }
  return { branch, dirty }
}

/**
 * Git status for the active server's working directory, refreshed on demand
 * (project open, after a save, manual click) by running git over the generic
 * exec RPC. Keyed by clientId so switching servers shows the right repo.
 * `null` = not a repo / git unavailable / not allowlisted.
 */
export const useGitStore = defineStore('git', {
  state: () => ({
    byClient: {} as Record<string, GitState | null>,
    loading: false,
  }),

  getters: {
    statusFor: (state) => (clientId: string | null) =>
      clientId ? state.byClient[clientId] ?? null : null,
  },

  actions: {
    async refresh(clientId: string | null, path: string) {
      if (!clientId || !path) return
      this.loading = true
      try {
        const res = await fileService.exec(clientId, GIT_STATUS_COMMAND, path)
        // code 0 = a git repo; anything else (128 not-a-repo, 126 blocked) → unknown.
        this.byClient[clientId] = res.code === 0 ? parseGitStatus(res.stdout) : null
      } catch {
        // Leave the previous value; a transient relay/timeout shouldn't clear it.
      } finally {
        this.loading = false
      }
    },

    clear(clientId: string) {
      delete this.byClient[clientId]
    },
  },
})
