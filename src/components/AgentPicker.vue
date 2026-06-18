<script setup lang="ts">
import { computed, ref } from 'vue'
import { Dialog, DialogPanel } from '@headlessui/vue'
import { ServerStackIcon, PlusIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/vue/20/solid'
import { useAgentsStore } from '@/stores/agents'
import { useSessionStore } from '@/stores/session'
import type { PublicClient } from '@/transport/types'
import { openContextMenu } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import ServerTelemetry from './ServerTelemetry.vue'
import SectionHeader from './ui/SectionHeader.vue'
import IconButton from './ui/IconButton.vue'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'

const agents = useAgentsStore()
const session = useSessionStore()

const search = ref('')
const addServerOpen = ref(false)

const filteredAgents = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return agents.sortedAgents
  return agents.sortedAgents.filter(
    (a) =>
      (a.hostname || '').toLowerCase().includes(q) ||
      a.clientId.toLowerCase().includes(q) ||
      (a.platform || '').toLowerCase().includes(q),
  )
})

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

function rtt(agent: PublicClient): string {
  return agent.pingRttMs == null ? '—' : `${agent.pingRttMs}ms`
}

const alertInfo = computed(() => (clientId: string) => {
  const snap = agents.alertsFor(clientId)
  if (!snap || !snap.totalCount) return null
  return { count: snap.totalCount, critical: !!snap.hasCritical }
})
</script>

<template>
  <div class="flex flex-col overflow-auto">
    <!-- Header: matches SectionHeader styling for consistency with FILES tab -->
    <SectionHeader>
      <div class="flex items-center gap-2">
        <ServerStackIcon class="size-4" />
        <span>Servers</span>
      </div>
      <template #actions>
        <IconButton :icon="PlusIcon" variant="plain" size="sm" label="link a new server" @click="addServerOpen = true" />
      </template>
    </SectionHeader>

    <!-- Search / filter -->
    <div class="relative mx-3 mt-2 mb-2">
      <MagnifyingGlassIcon class="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-subtle" />
      <input
        v-model="search"
        type="text"
        placeholder="filter…"
        class="w-full rounded bg-hover py-1 pl-6 pr-6 text-xs text-muted placeholder:text-subtle outline-none focus:ring-1 focus:ring-accent"
      />
      <button v-if="search" class="absolute right-1.5 top-1/2 -translate-y-1/2" @click="search = ''">
        <XMarkIcon class="size-3 text-subtle hover:text-fg" />
      </button>
    </div>

    <!-- List container -->
    <div class="flex-1 overflow-auto py-2">
      <!-- Empty states -->
      <p v-if="agents.agents.length === 0" class="mx-3 my-2 text-xs text-subtle">no servers online</p>
      <p v-else-if="filteredAgents.length === 0" class="mx-3 my-2 text-xs text-subtle">no matches</p>

      <!-- Online agents (sorted, filtered) -->
      <button
        v-for="agent in filteredAgents"
        :key="agent.clientId"
        class="flex w-full items-start gap-2 px-3 py-1.5 text-left text-muted hover:bg-hover"
        :class="{ 'bg-active text-fg': agent.clientId === session.activeClientId }"
        @click="pick(agent)"
        @contextmenu.prevent="serverMenu($event, agent)"
      >
        <span class="mt-[3px] size-[10px] shrink-0 rounded-full" :class="agent.authenticated ? 'bg-green' : 'bg-subtle'" />
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

      <!-- Offline / historical servers (hidden while searching) -->
      <template v-if="agents.offlineSeenServers.length && !search">
        <div class="mx-3 my-1.5 flex items-center gap-2">
          <div class="h-px flex-1 bg-line" />
          <span class="text-[10px] uppercase tracking-[0.1em] text-subtle">offline</span>
          <div class="h-px flex-1 bg-line" />
        </div>
        <div
          v-for="s in agents.offlineSeenServers"
          :key="s.clientId"
          class="flex items-start gap-2 px-3 py-1.5 opacity-50"
        >
          <span class="mt-[3px] size-[10px] shrink-0 rounded-full bg-subtle" />
        <span class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <span class="flex items-center gap-1.5">
            <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-muted">
              {{ s.hostname || s.clientId }}
            </span>
            <!-- Repeated disconnects indicate a death-loop -->
            <Badge
              v-if="s.disconnectCount >= 3"
              tone="warn"
              class="ml-auto shrink-0"
              :title="`disconnected ${s.disconnectCount} times — may be in a restart loop`"
            >×{{ s.disconnectCount }}</Badge>
          </span>
          <span class="text-xs text-subtle">{{ s.platform }}/{{ s.arch }}</span>
        </span>
      </div>
      </template>
    </div>
  </div>

  <!-- Add Server modal -->
  <Dialog :open="addServerOpen" class="relative z-[1100]" @close="addServerOpen = false">
    <div class="fixed inset-0 bg-black/40" aria-hidden="true" />
    <div class="fixed inset-0 flex items-center justify-center p-4">
      <DialogPanel class="w-full max-w-md rounded-lg border border-line bg-elevated p-5 shadow-2xl">
        <h2 class="text-base font-medium text-fg">Link a new server</h2>
        <p class="mt-2 text-sm text-muted">
          Install and run the compute-agent on the server you want to manage. It will appear here
          automatically once it connects to the control plane.
        </p>
        <pre class="mt-3 overflow-x-auto rounded bg-hover p-3 text-xs text-muted">compute-agent --config /etc/agent-config.json</pre>
        <p class="mt-2 text-xs text-subtle">
          The agent config must point to this control plane:
          <code class="ml-1 rounded bg-hover px-1 py-0.5 text-accent">{{ session.selectedControlPlane?.url ?? '—' }}</code>
        </p>
        <div class="mt-4 flex justify-end">
          <Button variant="secondary" @click="addServerOpen = false">Close</Button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>
</template>
