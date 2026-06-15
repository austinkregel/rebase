<script setup lang="ts">
import Terminal from '../Terminal.vue'

// dockview-vue hands each panel a single `params` prop = { api, containerApi,
// params: <our params> }. We forward the bound clientId/seq/cwd and the panel's
// own id + a title setter so the terminal can label its tab and register itself.
const props = defineProps<{
  params: {
    api: { id: string; setTitle: (title: string) => void }
    params: { clientId: string; seq: number; initialCwd?: string }
  }
}>()

// Wrap setTitle so it stays bound to the panel api — passing the bare method
// detaches `this` and dockview's setTitle dereferences `this.panel`.
function setTitle(title: string) {
  props.params.api.setTitle(title)
}
</script>

<template>
  <Terminal
    :panel-id="props.params.api.id"
    :client-id="props.params.params.clientId"
    :seq="props.params.params.seq"
    :initial-cwd="props.params.params.initialCwd"
    :set-title="setTitle"
  />
</template>
