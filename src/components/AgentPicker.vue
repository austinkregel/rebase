<script setup lang="ts">
import { computed } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { useSessionStore } from '@/stores/session'
import type { PublicClient } from '@/transport/types'
import { openContextMenu } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import ServerTelemetry from './ServerTelemetry.vue'
import SectionHeader from './ui/SectionHeader.vue'
import Badge from './ui/Badge.vue'

const agents = useAgentsStore()
const session = useSessionStore()

function pick(agent: PublicClient) {
  session.selectAgent(agent.clientId === session.activeClientId ? null : agent.clientId)
}

function serverMenu(event: MouseEvent, agent: PublicClient) {
  const items = menuItemsFor('server/context', {
    clientId: agent.clientId,
    hostname: agent.hostname,
    platform: agent.platform,
  })
  if (items.length) openContextMenu(event, items)
}

// Per-server round-trip latency to the control plane (ms), measured server-side
// from the echoed ping timestamp. Unlike the old "pong age", this is independent
// per agent rather than synchronized to the global heartbeat tick.
function rtt(agent: PublicClient): string {
  return agent.pingRttMs == null ? '—' : `${agent.pingRttMs}ms`
}

// Per-server alert summary (count + whether any are critical).
const alertInfo = computed(() => (clientId: string) => {
  const snap = agents.alertsFor(clientId)
  if (!snap || !snap.totalCount) return null
  return { count: snap.totalCount, critical: !!snap.hasCritical }
})
</script>

<template>
  <div class="border-b border-line pb-1.5">
    <SectionHeader :bordered="false">servers</SectionHeader>
    <p v-if="agents.agents.length === 0" class="mx-3 my-2 text-sm text-subtle">no servers online</p>
    <button
      v-for="agent in agents.agents"
      :key="agent.clientId"
      class="flex w-full items-start gap-2 px-3 py-1.5 text-left text-muted hover:bg-hover"
      :class="{ 'bg-active text-fg': agent.clientId === session.activeClientId }"
      @click="pick(agent)"
      @contextmenu.prevent="serverMenu($event, agent)"
    >
      <span class="mt-[5px] size-[7px] shrink-0 rounded-full" :class="agent.authenticated ? 'bg-green' : 'bg-subtle'" />
      <span class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span class="flex items-center gap-1.5">
          <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">
            {{ agent.hostname || agent.clientId }}
          </span>
          <Badge
            v-if="agent.directAddr"
            tone="accent"
            uppercase
            class="ml-auto"
            :title="`direct connection available at ${agent.directAddr}${agent.directPinRequired ? ' (pinned cert)' : ''}`"
          >P2P</Badge>
          <Badge
            v-if="alertInfo(agent.clientId)"
            :tone="alertInfo(agent.clientId)!.critical ? 'danger' : 'warn'"
            :class="agent.directAddr ? '' : 'ml-auto'"
            :title="`${alertInfo(agent.clientId)!.count} alert(s)`"
          >
            {{ alertInfo(agent.clientId)!.count }}
          </Badge>
        </span>
        <span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs font-light text-fg">
          {{ agent.platform }}/{{ agent.arch }} · {{ agent.agentVersion }} · {{ rtt(agent) }}
        </span>
        <ServerTelemetry :client-id="agent.clientId" />
      </span>
    </button>
  </div>
</template>
