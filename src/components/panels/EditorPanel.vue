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

const current = computed(() => files.openFiles.find((f) => f.path === path) ?? null)
const effectiveSettings = computed(() => settings.effective(projects.active?.editor))

// The viewer (if any) is determined by the file's MIME type and is stable for
// the panel's lifetime. `showSource` flips a toggle-capable viewer to the editor.
const viewer = viewerFor(path)
const showSource = ref(false)
const showEditor = computed(() => !viewer || (showSource.value && !!viewer.allowRawToggle))

function handleChange(doc: string) {
  if (!suppressChange) files.updateContent(path, doc)
}

async function handleSave() {
  try {
    await files.saveFile(path)
  } catch (err) {
    console.error('save failed', err)
  }
}

function loadDoc() {
  if (!view) return
  const f = current.value
  const doc = f && !f.loading && !f.error ? f.content : ''
  suppressChange = true
  view.setState(
    createEditorState({ doc, onChange: handleChange, onSave: handleSave, settings: effectiveSettings.value }),
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

// Push freshly-read content into the live view once the async read completes.
watch(
  () => current.value?.loading,
  (loading, wasLoading) => {
    if (!view || loading || !wasLoading) return
    const f = current.value
    if (!f || f.error) return
    suppressChange = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.content } })
    suppressChange = false
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

    <!-- Editor branch: plain text files, or a viewer's "View Source". -->
    <template v-if="showEditor">
      <div v-if="current?.loading" class="editor-banner">loading content…</div>
      <div v-else-if="current?.error" class="editor-banner error">
        <span class="msg">{{ current.error }}</span>
        <button class="retry" @click="files.reloadFile(path)">Retry</button>
      </div>
      <div ref="host" class="editor-host" />
    </template>

    <!-- Viewer branch: content-aware rendering. -->
    <component
      :is="viewer.component"
      v-else-if="viewer"
      class="viewer-host"
      :path="path"
      :client-id="clientId"
      :mime="mime"
      :content="current?.content ?? ''"
    />
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
