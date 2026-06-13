<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue'
import { BellIcon, ArrowRightStartOnRectangleIcon, CommandLineIcon } from '@heroicons/vue/20/solid'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { useFilesStore } from '@/stores/files'
import { useGitStore } from '@/stores/git'
import { useProjectsStore } from '@/stores/projects'
import { dock } from '@/services/dock'

const session = useSessionStore()
const agents = useAgentsStore()
const files = useFilesStore()
const gitStore = useGitStore()
const projects = useProjectsStore()

// Alerts for the active server (from the agent's stats/alerts snapshot).
const activeAlerts = computed(() =>
  session.activeClientId ? agents.alertsFor(session.activeClientId) : undefined,
)
const alertItems = computed(() => activeAlerts.value?.alerts ?? [])
const alertCount = computed(() => activeAlerts.value?.totalCount ?? 0)
const alertCritical = computed(() => !!activeAlerts.value?.hasCritical)

const now = ref(Date.now())
const timer = window.setInterval(() => (now.value = Date.now()), 1000)
onBeforeUnmount(() => window.clearInterval(timer))

const agent = computed(() =>
  session.activeClientId ? agents.byId(session.activeClientId) : undefined,
)

const pong = computed(() => {
  if (!agent.value?.lastPong) return null
  const secs = Math.max(0, Math.round((now.value - agent.value.lastPong) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${Math.round(secs / 3600)}h`
})

const connClass = computed(() => ({
  'text-green': session.socketStatus === 'open',
  'text-yellow': session.socketStatus === 'connecting',
  'text-red': session.socketStatus === 'closed',
}))

// Git segment reflects the active server's working-directory status.
const git = computed(() => gitStore.statusFor(session.activeClientId))

function refreshGit() {
  // Prefer the active project's primary root; fall back to the File explorer root.
  const root = projects.primaryRoot ?? files.rootPath
  void gitStore.refresh(session.activeClientId, root)
}
</script>

<template>
  <footer
    class="flex flex-shrink-0 items-center gap-3.5 whitespace-nowrap border-t border-line bg-surface px-3 py-[3px] text-[11px] text-subtle"
  >
    <span class="flex items-center gap-1" :class="connClass">
      {{ session.socketStatus === 'open' ? '●' : '○' }} {{ session.socketStatus }}
    </span>
    <span v-if="session.selectedControlPlane">{{ session.selectedControlPlane.name }}</span>
    <span>{{ agent ? agent.hostname || agent.clientId : 'no server' }}</span>
    <span v-if="pong" title="time since last pong">ping {{ pong }}</span>

    <button
      v-if="session.activeClientId"
      class="flex items-center gap-1 text-muted hover:text-fg disabled:opacity-50"
      :title="git ? 'git status — click to refresh' : 'fetch git status'"
      :disabled="gitStore.loading"
      @click="refreshGit"
    >
      <span v-if="git">⎇ {{ git.branch || 'detached' }}<span v-if="git.dirty" class="text-yellow"> ✎{{ git.dirty }}</span></span>
      <span v-else class="text-subtle">⎇ —</span>
    </button>

    <span class="flex-1" />

    <span v-if="files.activeFile" class="overflow-hidden text-ellipsis">{{ files.activeFile.path }}</span>
    <span v-if="files.dirtyCount" class="text-yellow">{{ files.dirtyCount }} unsaved</span>

    <button
      class="flex items-center text-subtle hover:text-fg disabled:opacity-50"
      title="new terminal"
      aria-label="new terminal"
      :disabled="!dock.openTerminal"
      @click="dock.openTerminal?.()"
    >
      <CommandLineIcon class="size-3.5" />
    </button>
    <Popover class="relative">
      <PopoverButton
        class="relative flex items-center text-subtle outline-none hover:text-fg"
        :class="{ 'text-red': alertCritical, 'text-yellow': alertCount && !alertCritical }"
        title="notifications"
      >
        <BellIcon class="size-3.5" />
        <span
          v-if="alertCount"
          class="absolute -right-1.5 -top-1 rounded-full px-1 text-[8px] leading-[1.4] tabular-nums"
          :class="alertCritical ? 'bg-red text-bg' : 'bg-yellow text-bg'"
        >{{ alertCount > 99 ? '99+' : alertCount }}</span>
      </PopoverButton>
      <PopoverPanel
        class="absolute bottom-6 right-0 z-50 max-h-80 w-80 overflow-auto rounded border border-line bg-elevated p-1 text-[11px] shadow-lg"
      >
        <p v-if="!session.activeClientId" class="p-2 text-subtle">no server selected</p>
        <p v-else-if="!alertItems.length" class="p-2 text-subtle">no alerts</p>
        <ul v-else class="flex flex-col gap-0.5">
          <li
            v-for="(a, i) in alertItems"
            :key="a.id ?? i"
            class="rounded px-2 py-1 hover:bg-hover"
          >
            <div class="flex items-center gap-1.5">
              <span
                class="shrink-0 rounded px-1 text-[8.5px] uppercase tracking-wide"
                :class="a.severity === 'critical'
                  ? 'bg-red/20 text-red'
                  : a.severity === 'warning'
                    ? 'bg-yellow/20 text-yellow'
                    : 'bg-line text-muted'"
              >{{ a.severity || 'info' }}</span>
              <span class="text-muted">{{ a.category }}</span>
              <span v-if="a.count && a.count > 1" class="ml-auto text-subtle">×{{ a.count }}</span>
            </div>
            <p class="mt-0.5 break-words text-fg">{{ a.message }}</p>
          </li>
        </ul>
      </PopoverPanel>
    </Popover>
    <button class="flex items-center gap-1 text-accent hover:opacity-80" @click="session.disconnect()">
      <ArrowRightStartOnRectangleIcon class="size-3.5" /> disconnect
    </button>
  </footer>
</template>
