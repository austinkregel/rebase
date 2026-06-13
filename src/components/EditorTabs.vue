<script setup lang="ts">
import { useFilesStore } from '@/stores/files'

const files = useFilesStore()

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
</script>

<template>
  <div v-if="files.openFiles.length" class="tabs">
    <div
      v-for="file in files.openFiles"
      :key="file.path"
      class="tab"
      :class="{ active: file.path === files.activePath }"
      :title="file.path"
      @click="files.activePath = file.path"
    >
      <span class="tab-name">{{ basename(file.path) }}</span>
      <button
        class="tab-close"
        :class="{ dirty: files.isDirty(file) }"
        @click.stop="files.closeFile(file.path)"
      >
        <span class="tab-close-x">×</span>
        <span class="tab-close-dot">●</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  overflow-x: auto;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  scrollbar-width: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 14px;
  border-right: 1px solid var(--border);
  color: var(--fg-subtle);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.tab:hover {
  color: var(--fg-muted);
}
.tab.active {
  background: var(--bg);
  color: var(--fg);
  box-shadow: inset 0 1px 0 var(--accent);
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 3px;
  color: var(--fg-subtle);
  font: inherit;
  cursor: pointer;
}
.tab-close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.tab-close-dot {
  display: none;
  font-size: 8px;
  color: var(--accent);
}
.tab-close.dirty .tab-close-x {
  display: none;
}
.tab-close.dirty .tab-close-dot {
  display: inline;
}
.tab-close.dirty:hover .tab-close-x {
  display: inline;
}
.tab-close.dirty:hover .tab-close-dot {
  display: none;
}
</style>
