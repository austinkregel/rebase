<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import { CodeBracketIcon, EyeIcon } from '@heroicons/vue/20/solid'
import { createEditorState, languageCompartment, languageFor, reconfigureSettings } from '@/cm/setup'
import { useFilesStore } from '@/stores/files'
import { useSettingsStore } from '@/stores/settings'
import { useProjectsStore } from '@/stores/projects'
import { viewerFor } from '@/services/viewers'
import { mimeForPath } from '@/services/mime'
import { notify } from '@/services/notifications'
import { baseName } from '@/services/paths'
import HexViewer from '@/components/viewers/HexViewer.vue'

// One panel per open file. A content-aware viewer may claim the file by MIME
// type (image/pdf/media/zip/markdown); otherwise it falls back to CodeMirror.
// Viewers that allow it expose a "View Source" toggle that swaps back to the
// editor over the same text buffer. dockview-vue hands each panel a single
// `params` prop = { params: <our params>, api, ... }.
const props = defineProps<{ params: { params: { path: string; clientId: string } } }>()
const path = props.params.params.path
const clientId = props.params.params.clientId
const mime = mimeForPath(path)

const files = useFilesStore()
const settings = useSettingsStore()
const projects = useProjectsStore()
const host = ref<HTMLElement | null>(null)

let view: EditorView | null = null
let suppressChange = false

const current = computed(
  () => files.openFiles.find((f) => f.clientId === clientId && f.path === path) ?? null,
)
const effectiveSettings = computed(() => settings.effective(projects.active?.editor))

// The viewer (if any) is determined by the file's MIME type and is stable for
// the panel's lifetime. `showSource` flips a toggle-capable viewer to the editor.
const viewer = viewerFor(path)
const showSource = ref(false)
// The store classifies the file (fileContent.resolveOpen) into a `kind`; the
// panel routes on that, not on the extension. `editable` gates whether the
// editor can write (clean text only).
const kind = computed(() => current.value?.kind ?? 'text')
const editable = computed(() => !!current.value?.editable)
const isHex = computed(() => kind.value === 'binary-hex')
const isBanner = computed(
  () => kind.value === 'special' || kind.value === 'directory' || kind.value === 'too-large',
)
const showViewer = computed(
  () => !!viewer && (kind.value === 'binary-viewer' || kind.value === 'text-viewer') && !showSource.value,
)

function handleChange(doc: string) {
  if (!suppressChange) files.updateContent(clientId, path, doc)
}

async function handleSave() {
  try {
    await files.saveFile(clientId, path)
  } catch (err) {
    notify.error(`Couldn't save ${baseName(path)}`, {
      source: 'Editor',
      body: err instanceof Error ? err.message : String(err),
    })
  }
}

function loadDoc() {
  if (!view) return
  const f = current.value
  const doc = f && !f.loading && !f.error ? f.content : ''
  suppressChange = true
  view.setState(
    createEditorState({
      doc,
      onChange: handleChange,
      onSave: handleSave,
      settings: effectiveSettings.value,
      readOnly: !editable.value,
    }),
  )
  suppressChange = false
  void languageFor(path).then((ext) => {
    if (view) view.dispatch({ effects: languageCompartment.reconfigure(ext) })
  })
}

// Mount/destroy CodeMirror as the editor branch enters/leaves the DOM (it lives
// behind a v-if, so the host element appears only when the editor is shown).
watch(
  host,
  (el) => {
    if (el && !view) {
      view = new EditorView({ state: createEditorState({ doc: '', onChange: handleChange, onSave: handleSave, settings: effectiveSettings.value }), parent: el })
      loadDoc()
    } else if (!el && view) {
      view.destroy()
      view = null
    }
  },
  { flush: 'post' },
)

onMounted(async () => {
  // First open / a tab restored from a saved layout: make sure the file is loaded.
  if (!current.value) await files.openFile(clientId, path)
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// Apply editor-settings changes live (no view rebuild).
watch(
  effectiveSettings,
  (s) => view?.dispatch({ effects: reconfigureSettings(s) }),
  { deep: true },
)

// Once the async classify+read completes, rebuild the state so both the content
// AND the correct read-only mode (editable was unknown while loading) apply.
watch(
  () => current.value?.loading,
  (loading, wasLoading) => {
    if (!view || loading || !wasLoading) return
    const f = current.value
    if (!f || f.error) return
    loadDoc()
  },
)
</script>

<template>
  <div class="editor-pane">
    <!-- Source/rendered toggle for viewers that opt in (markdown, svg). -->
    <div v-if="viewer && viewer.allowRawToggle" class="viewer-toolbar">
      <button class="toggle" @click="showSource = !showSource">
        <component :is="showSource ? EyeIcon : CodeBracketIcon" class="size-3.5" />
        <span>{{ showSource ? 'View Rendered' : 'View Source' }}</span>
      </button>
    </div>

    <!-- Loading / error apply to every kind. -->
    <div v-if="current?.loading" class="editor-banner">loading content…</div>
    <div v-else-if="current?.error" class="editor-banner error">
      <span class="msg">{{ current.error }}</span>
      <button class="retry" @click="files.reloadFile(clientId, path)">Retry</button>
    </div>

    <!-- Read-only hex for binary / lossy content. -->
    <HexViewer
      v-else-if="isHex"
      class="viewer-host"
      :path="path"
      :client-id="clientId"
      :size="current?.size ?? -1"
    />

    <!-- Not openable as text/viewer: directory, special file, or too large. -->
    <div v-else-if="isBanner" class="editor-banner info">
      <span class="msg">{{ current?.reason ?? 'This file can’t be opened here.' }}</span>
    </div>

    <!-- Content-aware viewer (image/pdf/media/zip/markdown/svg). -->
    <component
      :is="viewer.component"
      v-else-if="showViewer && viewer"
      class="viewer-host"
      :path="path"
      :client-id="clientId"
      :mime="mime"
      :content="current?.content ?? ''"
    />

    <!-- Editor: editable text, or a read-only preview (editable === false). -->
    <div v-else ref="host" class="editor-host" />
  </div>
</template>

<style scoped>
.editor-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.editor-host,
.viewer-host {
  flex: 1;
  min-height: 0;
}
.viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  padding: 3px 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.viewer-toolbar .toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  font-size: 12px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 4px;
}
.viewer-toolbar .toggle:hover {
  color: var(--fg);
}
.editor-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--fg-muted);
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
.editor-banner.error {
  color: var(--red);
}
.editor-banner .msg {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.editor-banner .retry {
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 8px;
  color: var(--muted);
}
.editor-banner .retry:hover {
  color: var(--fg);
}
</style>
