<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import { createEditorState, languageCompartment, languageFor, reconfigureSettings } from '@/cm/setup'
import { useFilesStore } from '@/stores/files'
import { useSettingsStore } from '@/stores/settings'
import { useProjectsStore } from '@/stores/projects'

// One CodeMirror instance per editor panel/tab — that's what lets Dockview
// show different files in split groups simultaneously. dockview-vue hands each
// panel a single `params` prop = { params: <our params>, api, ... }.
const props = defineProps<{ params: { params: { path: string; clientId: string } } }>()
const path = props.params.params.path
const clientId = props.params.params.clientId

const files = useFilesStore()
const settings = useSettingsStore()
const projects = useProjectsStore()
const host = ref<HTMLElement | null>(null)

let view: EditorView | null = null
let suppressChange = false

const current = computed(() => files.openFiles.find((f) => f.path === path) ?? null)
const effectiveSettings = computed(() => settings.effective(projects.active?.editor))

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

onMounted(async () => {
  view = new EditorView({
    state: createEditorState({ doc: '', onChange: handleChange, onSave: handleSave, settings: effectiveSettings.value }),
    parent: host.value!,
  })
  // First open / a tab restored from a saved layout: make sure the file is loaded.
  if (!current.value) await files.openFile(clientId, path)
  loadDoc()
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
    <!-- The editor is always mounted (so a tab clearly opens); loading/errors
         show as non-blocking banners over a visible, empty editor. -->
    <div v-if="current?.loading" class="editor-banner">loading content…</div>
    <div v-else-if="current?.error" class="editor-banner error">
      <span class="msg">{{ current.error }}</span>
      <button class="retry" @click="files.reloadFile(path)">Retry</button>
    </div>
    <div ref="host" class="editor-host" />
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
.editor-host {
  flex: 1;
  min-height: 0;
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
