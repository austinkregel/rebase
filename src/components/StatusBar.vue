<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { useFilesStore } from '@/stores/files'

const session = useSessionStore()
const agents = useAgentsStore()
const files = useFilesStore()

const agent = computed(() =>
  session.activeClientId ? agents.byId(session.activeClientId) : undefined,
)
</script>

<template>
  <footer class="status-bar">
    <span class="status-item" :class="`conn-${session.socketStatus}`">
      {{ session.socketStatus === 'open' ? '●' : '○' }} {{ session.socketStatus }}
    </span>
    <span v-if="session.selectedControlPlane" class="status-item">{{ session.selectedControlPlane.name }}</span>
    <span class="status-item">{{ agent ? (agent.hostname || agent.clientId) : 'no server selected' }}</span>
    <span v-if="files.activeFile" class="status-item path">{{ files.activeFile.path }}</span>
    <span class="status-spacer" />
    <span v-if="files.dirtyCount" class="status-item dirty">{{ files.dirtyCount }} unsaved</span>
    <button class="status-link" @click="session.disconnect()">disconnect</button>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 3px 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  color: var(--fg-subtle);
  font-size: 11px;
}
.status-item {
  white-space: nowrap;
}
.status-item.path {
  overflow: hidden;
  text-overflow: ellipsis;
}
.conn-open {
  color: var(--green);
}
.conn-connecting {
  color: var(--yellow);
}
.conn-closed {
  color: var(--red);
}
.status-spacer {
  flex: 1;
}
.status-item.dirty {
  color: var(--yellow);
}
.status-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
</style>
