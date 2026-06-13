<script setup lang="ts">
// Anchors the editor area when no file is open, so the default layout always
// shows a center region. Also a draggable panel for arranging the workspace.
defineProps<{ params?: unknown }>()
</script>

<template>
  <div class="welcome">
    <p class="brand">rebase</p>
    <p class="hint">select a file to start editing</p>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--bg);
}
.brand {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.08em;
  color: var(--fg-subtle);
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-subtle);
}
</style>
