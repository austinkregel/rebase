<script setup lang="ts">
import { computed } from 'vue'
import { useFileBytes } from './useFileBytes'
import { FILE_LIMITS } from '@/services/fileContent'

// Read-only hex/ASCII view for binary (or lossy-text) files that have no
// content viewer. Selected by the store's file classification (kind
// 'binary-hex'), never by extension. Renders a bounded prefix of the file.
const props = defineProps<{ path: string; clientId: string; size?: number }>()

// makeUrl:false — we want the raw bytes, not a Blob URL.
const { bytes, loading, error } = useFileBytes(props.path, props.clientId, 'application/octet-stream', false)

const RENDER_BYTES = FILE_LIMITS.hexPageBytes
const BYTES_PER_ROW = 16

const shown = computed(() => (bytes.value ? bytes.value.subarray(0, RENDER_BYTES) : new Uint8Array()))
const truncated = computed(() => !!bytes.value && bytes.value.length > RENDER_BYTES)

function hex(b: number): string {
  return b.toString(16).padStart(2, '0')
}

interface Row {
  offset: string
  cells: string[]
  ascii: string
}

const rows = computed<Row[]>(() => {
  const data = shown.value
  const out: Row[] = []
  for (let i = 0; i < data.length; i += BYTES_PER_ROW) {
    const slice = data.subarray(i, i + BYTES_PER_ROW)
    const cells: string[] = []
    let ascii = ''
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      if (j < slice.length) {
        const b = slice[j]
        cells.push(hex(b))
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
      } else {
        cells.push('  ')
        ascii += ' '
      }
    }
    out.push({ offset: i.toString(16).padStart(8, '0'), cells, ascii })
  }
  return out
})
</script>

<template>
  <div class="hex-view">
    <div v-if="loading" class="hex-banner">loading…</div>
    <div v-else-if="error" class="hex-banner error">{{ error }}</div>
    <template v-else>
      <div class="hex-note">
        Binary file{{ size && size >= 0 ? ` · ${size} bytes` : '' }} — read-only hex.
        <span v-if="truncated">Showing first {{ RENDER_BYTES }} bytes.</span>
      </div>
      <div class="hex-rows">
        <div v-for="row in rows" :key="row.offset" class="hex-row">
          <span class="off">{{ row.offset }}</span>
          <span class="bytes">
            <span v-for="(c, i) in row.cells" :key="i" class="cell">{{ c }}</span>
          </span>
          <span class="ascii">{{ row.ascii }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hex-view {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.hex-banner {
  padding: 8px 10px;
  color: var(--fg-muted);
}
.hex-banner.error {
  color: var(--red);
}
.hex-note {
  position: sticky;
  top: 0;
  padding: 4px 10px;
  color: var(--muted);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.hex-rows {
  padding: 6px 10px;
}
.hex-row {
  display: flex;
  gap: 16px;
  white-space: pre;
  line-height: 1.5;
}
.off {
  color: var(--muted);
}
.bytes .cell {
  margin-right: 6px;
  color: var(--fg);
}
.ascii {
  color: var(--fg-muted);
}
</style>
