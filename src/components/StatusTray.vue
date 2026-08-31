<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRightStartOnRectangleIcon } from '@heroicons/vue/20/solid'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { useFilesStore } from '@/stores/files'
import { useGitStore } from '@/stores/git'
import { useProjectsStore } from '@/stores/projects'
import IconButton from '@/components/ui/IconButton.vue'
import StatusItems from '@/components/StatusItems.vue'

const session = useSessionStore()
const agents = useAgentsStore()
const files = useFilesStore()
const gitStore = useGitStore()
const projects = useProjectsStore()

const agent = computed(() =>
  session.activeClientId ? agents.byId(session.activeClientId) : undefined,
)

// Round-trip latency to the active server (ms), measured server-side.
const rtt = computed(() =>
  agent.value?.pingRttMs == null ? null : `${agent.value.pingRttMs}ms`,
)

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
    class="flex flex-shrink-0 items-center gap-3.5 whitespace-nowrap border-t border-line bg-surface px-3 py-1.5 text-sm text-subtle"
  >
    <span class="flex items-center gap-1" :class="connClass">
      {{ session.socketStatus === 'open' ? '●' : '○' }} {{ session.socketStatus }}
    </span>
    <span v-if="session.selectedControlPlane">{{ session.selectedControlPlane.name }}</span>
    <button
      v-if="projects.inProjectMode"
      class="flex items-center gap-1 text-accent hover:opacity-80"
      title="In project mode — click to exit"
      @click="projects.exitProjectMode()"
    >
      ◆ {{ projects.focused?.name }}
    </button>
    <span>{{ agent ? agent.hostname || agent.clientId : 'no server' }}</span>
    <span v-if="rtt" title="round-trip latency to the control plane">ping {{ rtt }}</span>

    <button
      v-if="session.activeClientId"
      class="flex items-center gap-1 text-muted hover:text-fg disabled:opacity-50"
      :title="git ? 'git status — click to refresh' : 'fetch git status'"
      :disabled="gitStore.isLoading(session.activeClientId)"
      @click="refreshGit"
    >
      <span v-if="git">⎇ {{ git.branch || 'detached' }}<span v-if="git.dirty" class="text-yellow"> ✎{{ git.dirty }}</span></span>
      <span v-else class="text-subtle">⎇ —</span>
    </button>

    <StatusItems side="left" />

    <span class="flex-1" />

    <span v-if="files.activeFile" class="overflow-hidden text-ellipsis">{{ files.activeFile.path }}</span>
    <span v-if="files.dirtyCount" class="text-yellow">{{ files.dirtyCount }} unsaved</span>

    <!-- Plugin-contributed right-side items (terminal, notifications, …). -->
    <StatusItems side="right" />

    <IconButton
      :icon="ArrowRightStartOnRectangleIcon"
      variant="plain"
      size="lg"
      label="disconnect"
      class="text-accent hover:text-accent hover:opacity-80"
      @click="session.disconnect()"
    />
  </footer>
</template>
