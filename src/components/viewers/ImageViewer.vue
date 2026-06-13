<script setup lang="ts">
import { useFileBytes } from './useFileBytes'

// Raster image viewer. Fetches the file's bytes, wraps them in an object URL,
// and shows them in a fit-to-pane <img> over a checkerboard so transparency
// reads clearly. Handles png/jpg/gif/webp/bmp/ico/avif (SVG has its own viewer).
const props = defineProps<{ path: string; clientId: string; mime: string }>()
const { url, loading, error } = useFileBytes(props.path, props.clientId, props.mime)
</script>

<template>
  <div class="image-viewer">
    <div v-if="loading" class="note">loading image…</div>
    <div v-else-if="error" class="note error">{{ error }}</div>
    <img v-else-if="url" :src="url" :alt="path" class="image" />
  </div>
</template>

<style scoped>
.image-viewer {
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
  image-rendering: auto;
}
.note {
  font-size: 12px;
  color: var(--muted);
}
.note.error {
  color: var(--red);
}
</style>
