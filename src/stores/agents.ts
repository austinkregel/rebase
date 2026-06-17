import { defineStore } from 'pinia'
import { socket } from '@/transport/socket'
import type {
  AlertSnapshot,
  AlertsPayload,
  ClientListPayload,
  PublicClient,
  StatsData,
  StatsPayload,
} from '@/transport/types'

const SEEN_SERVERS_KEY = 'rebase.seen-servers'

export interface SeenServer {
  clientId: string
  hostname?: string
  platform?: string
  arch?: string
  agentVersion?: string
  firstSeen: number
  lastSeen: number
  connectCount: number
  disconnectCount: number
  isOnline: boolean
}

function loadSeenServers(): Record<string, SeenServer> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_SERVERS_KEY) || '{}')
  } catch {
    return {}
  }
}

export const useAgentsStore = defineStore('agents', {
  state: () => ({
    agents: [] as PublicClient[],
    /** Latest `stats` frame per agent (telemetry). */
    stats: {} as Record<string, StatsData>,
    /** Latest `alerts` snapshot per agent. */
    alerts: {} as Record<string, AlertSnapshot>,
    /** Every server ever seen, persisted across sessions for death-loop detection. */
    seenServers: loadSeenServers(),
    /** True once the first client_list event has been received this session. */
    _clientListReceived: false,
  }),

  getters: {
    byId: (state) => (clientId: string) => state.agents.find((a) => a.clientId === clientId),
    online: (state) => state.agents.filter((a) => a.authenticated),
    statsFor: (state) => (clientId: string) => state.stats[clientId],
    alertsFor: (state) => (clientId: string) => state.alerts[clientId],
    /** Agents sorted alphabetically by hostname (then clientId as tiebreak). */
    sortedAgents: (state) =>
      [...state.agents].sort((a, b) => {
        const na = (a.hostname || a.clientId).toLowerCase()
        const nb = (b.hostname || b.clientId).toLowerCase()
        return na.localeCompare(nb)
      }),
    /** Servers seen in prior sessions that are currently offline. */
    offlineSeenServers: (state): SeenServer[] => {
      if (!state._clientListReceived) return []
      return Object.values(state.seenServers)
        .filter((s) => !s.isOnline)
        .sort((a, b) => b.lastSeen - a.lastSeen)
    },
  },

  actions: {
    listen() {
      socket.on('client_list', (data) => {
        const incoming = (data as unknown as ClientListPayload).clientIds ?? []
        const now = Date.now()

        // Update seenServers: mark new arrivals and re-connections.
        for (const agent of incoming) {
          const existing = this.seenServers[agent.clientId]
          if (!existing) {
            this.seenServers[agent.clientId] = {
              clientId: agent.clientId,
              hostname: agent.hostname,
              platform: agent.platform,
              arch: agent.arch,
              agentVersion: agent.agentVersion,
              firstSeen: now,
              lastSeen: now,
              connectCount: 1,
              disconnectCount: 0,
              isOnline: true,
            }
          } else {
            const wasOffline = !existing.isOnline
            existing.isOnline = true
            existing.lastSeen = now
            if (agent.hostname) existing.hostname = agent.hostname
            if (agent.platform) existing.platform = agent.platform
            if (agent.arch) existing.arch = agent.arch
            if (agent.agentVersion) existing.agentVersion = agent.agentVersion
            if (wasOffline) existing.connectCount++
          }
        }

        // Mark agents that disappeared from the list as offline.
        const incomingIds = new Set(incoming.map((a) => a.clientId))
        for (const seen of Object.values(this.seenServers)) {
          if (!incomingIds.has(seen.clientId) && seen.isOnline) {
            seen.isOnline = false
            seen.disconnectCount++
          }
        }

        this.agents = incoming
        this._clientListReceived = true

        try {
          localStorage.setItem(SEEN_SERVERS_KEY, JSON.stringify(this.seenServers))
        } catch {
          /* storage unavailable */
        }
      })
      socket.on('stats', (data) => {
        const frame = data as unknown as StatsPayload
        if (frame.clientId) {
          this.stats[frame.clientId] = (frame.data ?? {}) as StatsData
          // Stats carries an embedded alerts snapshot; mirror it so the alerts
          // surface stays current even between dedicated `alerts` broadcasts.
          const embedded = (frame.data as StatsData | undefined)?.alerts
          if (embedded) this.alerts[frame.clientId] = embedded
        }
      })
      socket.on('alerts', (data) => {
        const frame = data as unknown as AlertsPayload
        if (frame.clientId) this.alerts[frame.clientId] = frame.data ?? {}
      })
    },
  },
})
