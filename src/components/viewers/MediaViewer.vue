<script setup lang="ts">
import { computed } from 'vue'
import { isVideo } from '@/services/mime'
import { useFileBytes } from './useFileBytes'

// Audio/video player. Streams the file into an object URL and hands it to the
// native <audio>/<video> element — the OS codecs do the work. Playable formats
// depend on the host webview (mp4/webm/ogg, mp3/wav/ogg/flac, …).
const props = defineProps<{ path: string; clientId: string; mime: string }>()
const { url, loading, error } = useFileBytes(props.path, props.clientId, props.mime)
const video = computed(() => isVideo(props.mime))
</script>

<template>
  <div class="media-viewer">
    <div v-if="loading" class="note">loading media…</div>
    <div v-else-if="error" class="note error">{{ error }}</div>
    <video v-else-if="url && video" :src="url" class="player" controls />
    <audio v-else-if="url" :src="url" controls />
  </div>
</template>

<style scoped>
.media-viewer {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 16px;
  background: var(--surface);
}
.player {
  max-width: 100%;
  max-height: 100%;
}
.note {
  font-size: 12px;
  color: var(--muted);
}
.note.error {
  color: var(--red);
}
</style>
