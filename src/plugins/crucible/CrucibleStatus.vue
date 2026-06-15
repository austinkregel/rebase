<script setup lang="ts">
import { computed } from 'vue'
import { ArrowPathIcon, SparklesIcon } from '@heroicons/vue/20/solid'
import { isTauri } from '@/transport/contract'
import { useProjectsStore } from '@/stores/projects'
import { rebuild } from '@/services/crucible'
import { indexStateFor, type IndexPhase } from '@/services/crucibleState'
import { formatTimeAgo } from '@/services/notifications'
import IconButton from '@/components/ui/IconButton.vue'

// Status-bar surface: shows the active project's index state and hosts the
// refresh button (the canonical place to rebuild, per the design).
const projects = useProjectsStore()
const supported = isTauri()

const project = computed(() => projects.active)
const state = computed(() => (project.value ? indexStateFor(project.value.id) : null))

const BUSY: IndexPhase[] = ['uploading', 'building', 'packing', 'downloading']
const busy = computed(() => !!state.value && BUSY.includes(state.value.phase))

const label = computed(() => {
  const s = state.value
  if (!s) return 'Crucible'
  switch (s.phase) {
    case 'uploading':
      return 'fetching indexer…'
    case 'building':
      return 'building index…'
    case 'packing':
      return 'packing index…'
    case 'downloading':
      return 'downloading index…'
    case 'ready':
      return s.lastIndexedAt ? `indexed ${formatTimeAgo(s.lastIndexedAt)}` : 'indexed'
    case 'stale':
      return 'index stale'
    case 'error':
      return 'index failed'
    default:
      return 'not indexed'
  }
})

const toneClass = computed(() => {
  switch (state.value?.phase) {
    case 'error':
      return 'text-red'
    case 'stale':
      return 'text-yellow'
    case 'ready':
      return 'text-fg'
    default:
      return ''
  }
})

function refresh() {
  if (project.value && !busy.value) void rebuild(project.value)
}
</script>

<template>
  <span v-if="supported && project" class="flex items-center gap-1" :title="state?.error">
    <SparklesIcon class="size-3.5" :class="busy ? 'animate-pulse text-accent' : 'text-subtle'" />
    <span :class="toneClass">{{ label }}</span>
    <IconButton
      :icon="ArrowPathIcon"
      variant="plain"
      label="rebuild Crucible index"
      :class="busy ? 'animate-spin text-accent' : ''"
      :disabled="busy"
      @click="refresh"
    />
  </span>
</template>
