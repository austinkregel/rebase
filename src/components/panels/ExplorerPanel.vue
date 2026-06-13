<script setup lang="ts">
import AgentPicker from '../AgentPicker.vue'
import FileTree from '../FileTree.vue'

// Consume dockview's `params` prop so it isn't applied as a DOM attribute.
defineProps<{ params?: unknown }>()
</script>

<template>
  <div class="explorer-panel">
    <AgentPicker />
    <FileTree />
  </div>
</template>

<style scoped>
.explorer-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-panel);
}
</style>
