import { defineStore } from 'pinia'
import { socket } from '@/transport/socket'
import type { SocketStatus } from '@/transport/contract'
import { platform, type ControlPlaneInfo } from '@/services/platform'
import { defaultRootForPlatform } from '@/services/paths'
import { useFilesStore } from './files'
import { useAgentsStore } from './agents'

/**
 * Connection lifecycle:
 *   loading → (no token) unauthenticated → disconnected → connecting → connected
 * "connected" means attached to a control plane; the user then picks a server
 * (an agent from the CP's client_list) which sets `activeClientId`.
 */
type Phase = 'loading' | 'unauthenticated' | 'disconnected' | 'connecting' | 'connected'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    phase: 'loading' as Phase,
    socketStatus: 'closed' as SocketStatus,
    authenticated: false,
    supportsCredentials: platform.supportsCredentials,
    controlPlanes: [] as ControlPlaneInfo[],
    selectedControlPlane: null as ControlPlaneInfo | null,
    /** The agent (server) the workbench addresses, picked from the CP's client_list. */
    activeClientId: null as string | null,
    error: null as string | null,
  }),

  actions: {
    async start() {
      socket.onStatus((status) => this.onStatus(status))
      // The rebase:// deep-link callback lands while the app is running.
      platform.onAuthChanged(() => void this.refreshAuth())
      platform.onAuthError((msg) => {
        this.error = msg
      })
      await this.refreshAuth()
    },

    async refreshAuth() {
      this.phase = 'loading'
      this.error = null
      try {
        const info = await platform.authStatus()
        this.authenticated = info.authenticated
        if (!info.authenticated) {
          this.phase = 'unauthenticated'
          return
        }
        this.controlPlanes = await platform.listControlPlanes().catch(() => [])
        this.phase = 'disconnected'
        // One control plane is the common case — connect straight through.
        if (this.controlPlanes.length === 1) {
          await this.connect(this.controlPlanes[0])
        }
      } catch (err) {
        this.error = message(err)
        this.authenticated = false
        this.phase = 'unauthenticated'
      }
    },

    /** Start CP-brokered browser sign-in (or paste-creds fallback via setCredentials). */
    async login() {
      this.error = null
      try {
        await platform.login(this.selectedControlPlane?.name)
      } catch (err) {
        this.error = message(err)
      }
    },

    async setCredentials(input: { token?: string; clientId?: string; clientSecret?: string }) {
      this.error = null
      try {
        await platform.setCredentials(input)
        await this.refreshAuth()
      } catch (err) {
        this.error = message(err)
      }
    },

    async connect(cp: ControlPlaneInfo) {
      this.error = null
      this.selectedControlPlane = cp
      socket.setTarget?.(cp.name)
      try {
        await socket.connect()
      } catch (err) {
        this.error = message(err)
        this.phase = 'disconnected'
      }
    },

    disconnect() {
      socket.close()
    },

    async logout() {
      socket.close()
      this.selectedControlPlane = null
      this.activeClientId = null
      await platform.logout().catch(() => {})
      await this.refreshAuth()
    },

    /** Pick which discovered server the workbench addresses. */
    selectAgent(clientId: string | null) {
      // Close buffers only on a real change, so panel remounts (e.g. dragging
      // the Explorer panel) don't wipe open files. Cached listings are keyed by
      // clientId and deliberately survive: the Project explorer lists roots from
      // every server at once, not just the active one.
      if (clientId !== this.activeClientId) {
        const files = useFilesStore()
        files.closeAllFiles()
        // Point the File explorer at the OS-appropriate root (C:\ on Windows,
        // / elsewhere). Projects own their own roots independently.
        const platformName = clientId ? useAgentsStore().byId(clientId)?.platform : undefined
        files.setBrowseRoot(defaultRootForPlatform(platformName))
        // Bring back the directory tree the user last had open on this server.
        if (clientId) void files.restore(clientId)
      }
      this.activeClientId = clientId
    },

    onStatus(status: SocketStatus) {
      this.socketStatus = status
      // The agent list is only meaningful while the socket carrying it is up.
      useAgentsStore().onSocketStatus(status)
      if (status === 'open') {
        this.phase = 'connected'
      } else if (status === 'connecting') {
        this.phase = 'connecting'
      } else if (status === 'closed') {
        if (this.phase === 'connected' || this.phase === 'connecting') {
          this.phase = this.authenticated ? 'disconnected' : 'unauthenticated'
        }
        this.activeClientId = null
        useFilesStore().reset()
      }
    },
  },
})
