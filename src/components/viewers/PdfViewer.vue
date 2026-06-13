<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
// `?url` yields the worker's asset URL without bundling pdf.js into the startup
// chunk — the library itself is dynamically imported below.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { fileService } from '@/services/fileService'

// PDF viewer backed by pdf.js — renders every page to a <canvas> for identical
// output across host webviews (WKWebView's native PDF support is unreliable).
const props = defineProps<{ path: string; clientId: string; mime: string }>()
const container = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const pageCount = ref(0)

let pdfDoc: PDFDocumentProxy | null = null
let loadingTask: PDFDocumentLoadingTask | null = null
let cancelled = false

async function renderAll(scaleBase: number) {
  const el = container.value
  if (!el || !pdfDoc) return
  const dpr = window.devicePixelRatio || 1
  const targetWidth = Math.max(320, el.clientWidth - 32)
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i)
    if (cancelled) return
    const unscaled = page.getViewport({ scale: 1 })
    const fit = Math.min(scaleBase, targetWidth / unscaled.width)
    const viewport = page.getViewport({ scale: fit * dpr })
    const canvas = document.createElement('canvas')
    canvas.className = 'page'
    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width / dpr}px`
    el.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    if (cancelled) return
  }
}

onMounted(async () => {
  try {
    const bytes = await fileService.readBytes(props.clientId, props.path)
    if (cancelled) return
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    loadingTask = pdfjs.getDocument({ data: bytes })
    pdfDoc = await loadingTask.promise
    if (cancelled) return
    pageCount.value = pdfDoc.numPages
    await renderAll(2)
  } catch (err) {
    if (!cancelled) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  cancelled = true
  void loadingTask?.destroy()
  pdfDoc = null
  loadingTask = null
})
</script>

<template>
  <div class="pdf-viewer">
    <div v-if="loading" class="note">loading PDF…</div>
    <div v-else-if="error" class="note error">{{ error }}</div>
    <div ref="container" class="pages" />
  </div>
</template>

<style scoped>
.pdf-viewer {
  height: 100%;
  overflow: auto;
  background: var(--surface);
}
.pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px;
}
.pages :deep(.page) {
  max-width: 100%;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
  background: #fff;
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
