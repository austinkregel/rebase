import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const saved: Record<string, unknown> = {}
vi.mock('@/services/store', () => ({
  loadValueMigrating: vi.fn(async (key: string, _legacy: string, fallback: unknown) =>
    key in saved ? JSON.parse(JSON.stringify(saved[key])) : fallback,
  ),
  saveValue: vi.fn(async (key: string, value: unknown) => {
    saved[key] = JSON.parse(JSON.stringify(value))
  }),
}))
// The store subscribes on listen(); nothing here exercises the wire.
vi.mock('@/transport/socket', () => ({ socket: { on: vi.fn(), onStatus: vi.fn() } }))

import { useAgentsStore, type SeenServer } from './agents'

function seen(clientId: string, over: Partial<SeenServer> = {}): SeenServer {
  return {
    clientId,
    hostname: clientId,
    firstSeen: 1,
    lastSeen: 2,
    connectCount: 1,
    disconnectCount: 0,
    isOnline: true,
    ...over,
  }
}

/** Bring the store to "socket up, client_list delivered". */
function connected(...clientIds: string[]) {
  const agents = useAgentsStore()
  agents.onSocketStatus('open')
  agents.agents = clientIds.map((clientId) => ({
    clientId,
    hostname: clientId,
    authenticated: true,
  })) as never
  agents._clientListReceived = true
  for (const id of clientIds) agents.seenServers[id] = seen(id)
  return agents
}

describe('agents store — reachability', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const key of Object.keys(saved)) delete saved[key]
  })

  it('reports nothing online before the socket is up', () => {
    const agents = useAgentsStore()
    expect(agents.isOnline('c1')).toBe(false)
  })

  it('is optimistic only in the window between socket-open and client_list', () => {
    const agents = useAgentsStore()
    agents.onSocketStatus('open')
    expect(agents.isOnline('c1')).toBe(true)
    agents.agents = [{ clientId: 'c1', authenticated: true }] as never
    agents._clientListReceived = true
    expect(agents.isOnline('c1')).toBe(true)
    expect(agents.isOnline('c2')).toBe(false)
  })

  it('supports() reflects an agent’s advertised capabilities', () => {
    const agents = useAgentsStore()
    agents.agents = [
      { clientId: 'c1', authenticated: true, capabilities: ['file_get.range'] },
      { clientId: 'c2', authenticated: true },
    ] as never
    expect(agents.supports('c1', 'file_get.range')).toBe(true)
    expect(agents.supports('c1', 'file_patch')).toBe(false)
    expect(agents.supports('c2', 'file_get.range')).toBe(false)
    expect(agents.supports(null, 'file_get.range')).toBe(false)
  })

  it('drops the client_list when the socket closes', () => {
    const agents = connected('c1')
    expect(agents.isOnline('c1')).toBe(true)
    agents.onSocketStatus('closed')
    // The list is not merely stale, it is unusable: requests go over that socket.
    expect(agents.agents).toEqual([])
    expect(agents.isOnline('c1')).toBe(false)
  })

  it('does not go optimistic again on reconnect', () => {
    const agents = connected('c1')
    agents.onSocketStatus('closed')
    agents.onSocketStatus('open')
    // Socket is back but the new client_list has not arrived. Having once been
    // told the truth, guessing again would be a regression, not a kindness.
    expect(agents.isOnline('c1')).toBe(false)
  })

  it('treats "connecting" as down', () => {
    const agents = connected('c1')
    agents.onSocketStatus('connecting')
    expect(agents.isOnline('c1')).toBe(false)
  })

  it('clears telemetry so a reconnect cannot render last session as current', () => {
    const agents = connected('c1')
    agents.stats['c1'] = { cpu: 90 } as never
    agents.alerts['c1'] = { disk: 'critical' } as never
    agents.onSocketStatus('closed')
    expect(agents.statsFor('c1')).toBeUndefined()
    expect(agents.alertsFor('c1')).toBeUndefined()
  })
})

describe('agents store — seen-server history', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const key of Object.keys(saved)) delete saved[key]
  })

  it('marks seen servers offline on disconnect without blaming them', () => {
    const agents = connected('c1', 'c2')
    agents.seenServers['c1'].disconnectCount = 2
    agents.onSocketStatus('closed')
    expect(agents.seenServers['c1'].isOnline).toBe(false)
    expect(agents.seenServers['c2'].isOnline).toBe(false)
    // Our connection dropped, not theirs. disconnectCount drives the "restart
    // loop" badge at >= 3; bumping it here would libel a healthy server.
    expect(agents.seenServers['c1'].disconnectCount).toBe(2)
    expect(agents.seenServers['c2'].disconnectCount).toBe(0)
  })

  it('persists the offline marks rather than only holding them in memory', () => {
    const agents = connected('c1')
    agents.onSocketStatus('closed')
    const stored = saved['seen-servers'] as Record<string, SeenServer>
    expect(stored['c1'].isOnline).toBe(false)
  })

  it('lists them as offline so the picker still shows them while disconnected', () => {
    const agents = connected('c1')
    agents.onSocketStatus('closed')
    expect(agents.offlineSeenServers.map((s) => s.clientId)).toEqual(['c1'])
  })

  it('never adopts a persisted isOnline from a previous process', async () => {
    saved['seen-servers'] = { c1: seen('c1', { isOnline: true }) }
    const agents = useAgentsStore()
    await agents.hydrate()
    // Quitting while connected saved `true`; that says nothing about this run.
    expect(agents.seenServers['c1'].isOnline).toBe(false)
    expect(agents.isOnline('c1')).toBe(false)
  })

  it('lets a live client_list win over the hydrated history', async () => {
    saved['seen-servers'] = { c1: seen('c1', { hostname: 'stale', connectCount: 9 }) }
    const agents = connected('c1')
    await agents.hydrate()
    expect(agents.seenServers['c1'].hostname).toBe('c1')
  })
})

describe('agents store — naming', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const key of Object.keys(saved)) delete saved[key]
  })

  it('prefers the hostname from the live list', () => {
    const agents = connected('c1')
    expect(agents.displayName('c1')).toBe('c1')
  })

  it('falls back to the seen history once the live list is gone', () => {
    const agents = useAgentsStore()
    agents.onSocketStatus('open')
    agents.seenServers['abc123'] = seen('abc123', { hostname: 'mnemosyne' })
    agents.onSocketStatus('closed')
    // The error a user reads after a drop should still name the machine.
    expect(agents.displayName('abc123')).toBe('mnemosyne')
  })

  it('falls back to the raw client id when nothing knows a hostname', () => {
    expect(useAgentsStore().displayName('abc123')).toBe('abc123')
  })
})
