<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { DocumentIcon, PhotoIcon } from '@heroicons/vue/20/solid'
import { fileService } from '@/services/fileService'
import { decodeText } from '@/transport/encoding'
import { isImage, mimeForPath } from '@/services/mime'

// Zip browser. Reads the archive bytes and lists its central directory via
// fflate without writing anything to disk; an entry is inflated only when the
// user clicks it. Text entries preview as text, images render inline, anything
// else shows a size note.
const props = defineProps<{ path: string; clientId: string; mime: string }>()

interface ZipEntry {
  name: string
  size: number
}

const entries = ref<ZipEntry[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const selected = ref<string | null>(null)
const previewText = ref<string | null>(null)
const previewImage = ref<string | null>(null)
const previewNote = ref<string | null>(null)
const previewLoading = ref(false)

const archive = shallowRef<Uint8Array | null>(null)

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function clearPreview() {
  if (previewImage.value) URL.revokeObjectURL(previewImage.value)
  previewImage.value = null
  previewText.value = null
  previewNote.value = null
}

async function listEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  const { unzip } = await import('fflate')
  return new Promise((resolve, reject) => {
    const found: ZipEntry[] = []
    // Returning false skips decompression — we only want the directory here.
    unzip(bytes, { filter: (f) => { if (!f.name.endsWith('/')) found.push({ name: f.name, size: f.originalSize }); return false } }, (err) => {
      if (err) reject(err)
      else resolve(found.sort((a, b) => a.name.localeCompare(b.name)))
    })
  })
}

async function extract(name: string): Promise<Uint8Array> {
  const bytes = archive.value
  if (!bytes) throw new Error('archive not loaded')
  const { unzip } = await import('fflate')
  return new Promise((resolve, reject) => {
    unzip(bytes, { filter: (f) => f.name === name }, (err, data) => {
      if (err) reject(err)
      else resolve(data[name])
    })
  })
}

async function open(entry: ZipEntry) {
  selected.value = entry.name
  clearPreview()
  previewLoading.value = true
  try {
    const data = await extract(entry.name)
    const entryMime = mimeForPath(entry.name)
    if (isImage(entryMime)) {
      previewImage.value = URL.createObjectURL(new Blob([data], { type: entryMime }))
    } else if (data.length > 2 * 1024 * 1024) {
      previewNote.value = `${fmtSize(data.length)} — too large to preview`
    } else if (entryMime.startsWith('text/') || entryMime === 'application/octet-stream') {
      // Best-effort text decode; binary blobs just render as mojibake, which is
      // a fair signal that there's nothing to read here.
      previewText.value = decodeText(data)
    } else {
      previewNote.value = `${entryMime} · ${fmtSize(data.length)}`
    }
  } catch (err) {
    previewNote.value = err instanceof Error ? err.message : String(err)
  } finally {
    previewLoading.value = false
  }
}

onMounted(async () => {
  try {
    const bytes = await fileService.readBytes(props.clientId, props.path)
    archive.value = bytes
    entries.value = await listEntries(bytes)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(clearPreview)
</script>

<template>
  <div class="zip-viewer">
    <div v-if="loading" class="note">reading archive…</div>
    <div v-else-if="error" class="note error">{{ error }}</div>
    <template v-else>
      <ul class="entries">
        <li class="count">{{ entries.length }} entries</li>
        <li
          v-for="e in entries"
          :key="e.name"
          class="entry"
          :class="{ active: e.name === selected }"
          @click="open(e)"
        >
          <component :is="isImage(mimeForPath(e.name)) ? PhotoIcon : DocumentIcon" class="icon" />
          <span class="name">{{ e.name }}</span>
          <span class="size">{{ fmtSize(e.size) }}</span>
        </li>
      </ul>
      <div class="preview">
        <div v-if="previewLoading" class="note">extracting…</div>
        <div v-else-if="!selected" class="note">select an entry to preview</div>
        <img v-else-if="previewImage" :src="previewImage" class="preview-image" :alt="selected" />
        <pre v-else-if="previewText !== null" class="preview-text">{{ previewText }}</pre>
        <div v-else-if="previewNote" class="note">{{ previewNote }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.zip-viewer {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.entries {
  flex-shrink: 0;
  width: 260px;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--surface);
}
.count {
  padding: 6px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--subtle);
}
.entry {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--fg-muted);
  cursor: pointer;
}
.entry:hover {
  background: var(--hover);
}
.entry.active {
  background: var(--hover);
  color: var(--fg);
}
.entry .icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--subtle);
}
.entry .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry .size {
  flex-shrink: 0;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.preview-text {
  margin: 0;
  padding: 12px 14px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  color: var(--fg);
}
.preview-image {
  display: block;
  max-width: 100%;
  margin: 16px auto;
}
.note {
  padding: 16px;
  font-size: 12px;
  color: var(--muted);
}
.note.error {
  color: var(--red);
}
</style>
