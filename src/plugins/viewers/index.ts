import { markRaw } from 'vue'
import { definePlugin } from '@/services/plugins'
import ImageViewer from '@/components/viewers/ImageViewer.vue'
import SvgViewer from '@/components/viewers/SvgViewer.vue'
import MediaViewer from '@/components/viewers/MediaViewer.vue'
import PdfViewer from '@/components/viewers/PdfViewer.vue'
import MarkdownViewer from '@/components/viewers/MarkdownViewer.vue'
import ZipViewer from '@/components/viewers/ZipViewer.vue'

// The built-in content-aware viewers, shipped as a plugin that dogfoods the
// `registerViewer` API — a third party could add a `.glb` or `.parquet` viewer
// the same way. Viewers claim MIME types (see services/mime.ts maps the file's
// extension → MIME). `binary: true` viewers fetch their own bytes and are
// read-only; text-backed viewers (svg, markdown) render the editor's text buffer
// and expose a "View Source" toggle.
//
// SVG resolves to `image/svg+xml`, which an exact match claims over the
// `image/*` raster viewer — so svg gets the source toggle, png/jpg/etc. don't.
export default definePlugin({
  id: 'core.viewers',
  name: 'File Viewers',
  activate(ctx) {
    ctx.registerViewer({ id: 'core.image', mimeTypes: ['image/*'], binary: true, component: markRaw(ImageViewer) })
    ctx.registerViewer({ id: 'core.svg', mimeTypes: ['image/svg+xml'], binary: false, allowRawToggle: true, component: markRaw(SvgViewer) })
    ctx.registerViewer({ id: 'core.media', mimeTypes: ['audio/*', 'video/*'], binary: true, component: markRaw(MediaViewer) })
    ctx.registerViewer({ id: 'core.pdf', mimeTypes: ['application/pdf'], binary: true, component: markRaw(PdfViewer) })
    ctx.registerViewer({ id: 'core.zip', mimeTypes: ['application/zip'], binary: true, component: markRaw(ZipViewer) })
    ctx.registerViewer({ id: 'core.markdown', mimeTypes: ['text/markdown'], binary: false, allowRawToggle: true, component: markRaw(MarkdownViewer) })
  },
})
