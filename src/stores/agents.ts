import { defineStore } from 'pinia'
import { socket } from '@/transport/socket'
import type { SocketStatus } from '@/transport/contract'
import { loadValueMigrating, saveValue } from '@/services/store'
import type {
  AlertSnapshot,
  AlertsPayload,
  ClientListPayload,
  PublicClient,
  StatsData,
  StatsPayload,
} from '@/transport/types'

// Persisted through services/store.ts (tauri-plugin-store on desktop,
// localStorage in the browser) — never localStorage directly, or desktop state
// ends up split between rebase.json and the webview.
const SEEN_SERVERS_KEY = 'seen-servers'
const SEEN_SERVERS_LEGACY_KEY = 'rebase.seen-servers'

/**
 * Thrown instead of sending a request to an agent the control plane has not
 * listed as connected. The CP does answer such requests — but its rejection
 * carries no `requestId`, so `rpc.expect` drops it and the caller would hang
 * for the full timeout and then fail with a meaningless "timed out" (see
 * docs/PROTOCOL.md). Failing here turns that into an immediate, honest error.
 */
export class AgentOfflineError extends Error {
  constructor(public readonly clientId: string, name: string) {
    super(`${name} is offline`)
    this.name = 'AgentOfflineError'
  }
}

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


export const useAgentsStore = defineStore('agents', {
  state: () => ({
    agents: [] as PublicClient[],
    /** Latest `stats` frame per agent (telemetry). */
    stats: {} as Record<string, StatsData>,
    /** Latest `alerts` snapshot per agent. */
    alerts: {} as Record<string, AlertSnapshot>,
    /** Every server ever seen, persisted across sessions for death-loop
     *  detection. Empty until hydrate() resolves. */
    seenServers: {} as Record<string, SeenServer>,
    /** True once the first client_list event has been received this session.
     *  Survives a reconnect: it gates optimism (below) and the offline list,
     *  neither of which should snap back to its startup answer on a blip. */
    _clientListReceived: false,
    /** Whether the control-plane socket is up. Every agent is addressed through
     *  it, so while it is down nothing is reachable regardless of client_list. */
    socketOpen: false,
  }),

  getters: {
    byId: (state) => (clientId: string) => state.agents.find((a) => a.clientId === clientId),
    online: (state) => state.agents.filter((a) => a.authenticated),
    /** Whether an agent is connected and worth addressing a request to.
     *  Optimistic in exactly one window — socket up, first `client_list` not in
     *  yet — because the list is empty there and answering "offline" would fail
     *  every restored listing on a perfectly healthy connection. With the socket
     *  down there is no healthy connection to be optimistic about. */
    isOnline:
      (state) =>
      (clientId: string | null): boolean =>
        !!clientId &&
        state.socketOpen &&
        (!state._clientListReceived ||
          !!state.agents.find((a) => a.clientId === clientId)?.authenticated),
    /** Hostname if we know one — from the live list, else the seen-server
     *  history, so a server that just went offline is still named rather than
     *  reduced to its client id in the error the user reads. */
    displayName:
      (state) =>
      (clientId: string): string =>
        state.agents.find((a) => a.clientId === clientId)?.hostname ||
        state.seenServers[clientId]?.hostname ||
        clientId,
    statsFor: (state) => (clientId: string) => state.stats[clientId],
    alertsFor: (state) => (clientId: string) => state.alerts[clientId],
    /** Whether an agent advertises a protocol capability (e.g. "file_get.range").
     *  Absent capabilities ⇒ false, so callers surface an explicit "unsupported"
     *  error rather than silently attempting an operation the agent can't serve. */
    supports:
      (state) =>
      (clientId: string | null, capability: string): boolean =>
        !!clientId &&
        !!state.agents.find((a) => a.clientId === clientId)?.capabilities?.includes(capability),
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
    /** Hydrate the seen-server history (call once at startup). Merges rather
     *  than replaces: a `client_list` can land before this resolves, and what
     *  we just learned about a live server beats what we saved last run. */
    async hydrate() {
      const stored = await loadValueMigrating<Record<string, SeenServer>>(
        SEEN_SERVERS_KEY,
        SEEN_SERVERS_LEGACY_KEY,
        {},
      )
      // A persisted `isOnline` describes the process that wrote it. Quitting
      // while connected saves `true` for every server, which would otherwise
      // come back next launch as a claim that they are all up.
      for (const seen of Object.values(stored)) seen.isOnline = false
      this.seenServers = { ...stored, ...this.seenServers }
    },

    /** Follow the control-plane socket. Every agent is reached through it, so
     *  while it is down the last `client_list` describes servers we can no
     *  longer address — and a stale "online" costs the caller a full rpc
     *  timeout (see AgentOfflineError). Drop it rather than let it answer. */
    onSocketStatus(status: SocketStatus) {
      this.socketOpen = status === 'open'
      if (this.socketOpen) return
      this.agents = []
      // Telemetry is a snapshot of a moment that has passed; keeping it would
      // render last session's load as current for the first frames after a
      // reconnect. Both maps refill from the next stats/alerts broadcast.
      this.stats = {}
      this.alerts = {}
      // Losing sight of a server is not the same event as the server going
      // down — the CP connection dropped, not the agent. Mark them offline so
      // the picker says so, but leave disconnectCount alone: it drives the
      // "may be in a restart loop" warning, and this is no evidence of one.
      let changed = false
      for (const seen of Object.values(this.seenServers)) {
        if (seen.isOnline) {
          seen.isOnline = false
          changed = true
        }
      }
      if (changed) void saveValue(SEEN_SERVERS_KEY, this.seenServers)
    },

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

        void saveValue(SEEN_SERVERS_KEY, this.seenServers)
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
