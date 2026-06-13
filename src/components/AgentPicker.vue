<script setup lang="ts">
import { computed } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { useSessionStore } from '@/stores/session'
import type { PublicClient } from '@/transport/types'
import ServerTelemetry from './ServerTelemetry.vue'

const agents = useAgentsStore()
const session = useSessionStore()

function pick(agent: PublicClient) {
  session.selectAgent(agent.clientId === session.activeClientId ? null : agent.clientId)
}

function pongAge(agent: PublicClient): string {
  if (!agent.lastPong) return ''
  const seconds = Math.max(0, Math.round((Date.now() - agent.lastPong) / 1000))
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
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
    <p class="mx-3 mb-1 mt-2 text-[10.5px] uppercase tracking-[0.12em] text-subtle">servers</p>
    <p v-if="agents.agents.length === 0" class="mx-3 my-2 text-[12px] text-subtle">no servers online</p>
    <button
      v-for="agent in agents.agents"
      :key="agent.clientId"
      class="flex w-full items-start gap-2 px-3 py-[6px] text-left text-muted hover:bg-hover"
      :class="{ 'bg-active text-fg': agent.clientId === session.activeClientId }"
      @click="pick(agent)"
    >
      <span class="mt-[5px] size-[7px] shrink-0 rounded-full" :class="agent.authenticated ? 'bg-green' : 'bg-subtle'" />
      <span class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <span class="flex items-center gap-1.5">
          <span class="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-fg">
            {{ agent.hostname || agent.clientId }}
          </span>
          <span
            v-if="agent.directAddr"
            class="ml-auto shrink-0 rounded bg-accent/15 px-1 text-[9px] uppercase tracking-wide text-accent"
            :title="`direct connection available at ${agent.directAddr}${agent.directPinRequired ? ' (pinned cert)' : ''}`"
          >P2P</span>
          <span
            v-if="alertInfo(agent.clientId)"
            class="shrink-0 rounded px-1 text-[9px] tabular-nums"
            :class="[alertInfo(agent.clientId)!.critical ? 'bg-red/20 text-red' : 'bg-yellow/20 text-yellow', agent.directAddr ? '' : 'ml-auto']"
            :title="`${alertInfo(agent.clientId)!.count} alert(s)`"
          >
            {{ alertInfo(agent.clientId)!.count }}
          </span>
        </span>
        <span class="overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-subtle">
          {{ agent.platform }}/{{ agent.arch }} · {{ agent.agentVersion }} · pong {{ pongAge(agent) }}
        </span>
        <ServerTelemetry :client-id="agent.clientId" />
      </span>
    </button>
  </div>
</template>
