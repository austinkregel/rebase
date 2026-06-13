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

export const useAgentsStore = defineStore('agents', {
  state: () => ({
    agents: [] as PublicClient[],
    /** Latest `stats` frame per agent (telemetry). */
    stats: {} as Record<string, StatsData>,
    /** Latest `alerts` snapshot per agent. */
    alerts: {} as Record<string, AlertSnapshot>,
  }),

  getters: {
    byId: (state) => (clientId: string) => state.agents.find((a) => a.clientId === clientId),
    online: (state) => state.agents.filter((a) => a.authenticated),
    statsFor: (state) => (clientId: string) => state.stats[clientId],
    alertsFor: (state) => (clientId: string) => state.alerts[clientId],
  },

  actions: {
    listen() {
      socket.on('client_list', (data) => {
        this.agents = (data as unknown as ClientListPayload).clientIds ?? []
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
