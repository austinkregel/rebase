<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from 'vue'

// SVG viewer. SVG is text, so the panel reads it as a normal text buffer and
// passes the source here; we render it via a blob URL. Because it's text-backed,
// the panel's "View Source" toggle edits the very same buffer (CodeMirror), and
// the preview re-renders live as `content` changes.
const props = defineProps<{ path: string; clientId: string; mime: string; content: string }>()
const url = ref<string | null>(null)

watchEffect(() => {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = props.content
    ? URL.createObjectURL(new Blob([props.content], { type: 'image/svg+xml' }))
    : null
})

onBeforeUnmount(() => {
  if (url.value) URL.revokeObjectURL(url.value)
})
</script>

<template>
  <div class="svg-viewer">
    <img v-if="url" :src="url" :alt="path" class="image" />
  </div>
</template>

<style scoped>
.svg-viewer {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  overflow: auto;
  padding: 16px;
  background-color: var(--surface);
  background-image:
    linear-gradient(45deg, rgba(128, 128, 128, 0.12) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128, 128, 128, 0.12) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.12) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.12) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
</style>
