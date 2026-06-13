<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import { createEditorState, languageCompartment, languageFor } from '@/cm/setup'
import { useFilesStore } from '@/stores/files'

const files = useFilesStore()
const host = ref<HTMLElement | null>(null)

let view: EditorView | null = null
// Path the view's current document belongs to, so the updateListener can tell
// user edits apart from programmatic document swaps.
let viewPath: string | null = null
let suppressChange = false

function handleChange(doc: string) {
  if (suppressChange || !viewPath) return
  files.updateContent(viewPath, doc)
}

async function handleSave() {
  if (!viewPath) return
  try {
    await files.saveFile(viewPath)
  } catch (err) {
    console.error('save failed', err)
  }
}

function applyLanguage(path: string) {
  void languageFor(path).then((extension) => {
    // Stale if the user switched files while the pack was loading.
    if (!view || viewPath !== path) return
    view.dispatch({ effects: languageCompartment.reconfigure(extension) })
  })
}

function showFile(path: string | null) {
  if (!view) return
  const file = path ? files.openFiles.find((f) => f.path === path) : null
  const doc = file && !file.loading && !file.error ? file.content : ''
  suppressChange = true
  view.setState(createEditorState({ doc, onChange: handleChange, onSave: handleSave }))
  suppressChange = false
  viewPath = path
  if (path) applyLanguage(path)
}

onMounted(() => {
  view = new EditorView({
    state: createEditorState({ doc: '', onChange: handleChange, onSave: handleSave }),
    parent: host.value!,
  })
  if (files.activePath) showFile(files.activePath)
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

watch(
  () => files.activePath,
  (path) => showFile(path),
)

// A file that finished loading after being opened (async read) needs its
// fresh content pushed into the live view — as a transaction, not a rebuild.
watch(
  () => files.activeFile?.loading,
  (loading, wasLoading) => {
    if (!view || !viewPath || loading || !wasLoading) return
    const file = files.activeFile
    if (!file || file.path !== viewPath || file.error) return
    suppressChange = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: file.content },
    })
    suppressChange = false
  },
)
</script>

<template>
  <div class="editor-pane">
    <div v-if="files.activeFile?.loading" class="editor-overlay">loading…</div>
    <div v-else-if="files.activeFile?.error" class="editor-overlay error">
      {{ files.activeFile.error }}
    </div>
    <div v-else-if="!files.activeFile" class="editor-overlay quiet">
      <p>rebase</p>
      <p class="hint">select a file to start editing</p>
    </div>
    <div ref="host" class="editor-host" :class="{ hidden: !files.activeFile || files.activeFile.loading || files.activeFile.error }" />
  </div>
</template>

<style scoped>
.editor-pane {
  position: relative;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.editor-host {
  height: 100%;
}
.editor-host.hidden {
  visibility: hidden;
}
.editor-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--fg-muted);
  font-size: 13px;
  z-index: 1;
}
.editor-overlay.error {
  color: var(--red);
  padding: 24px;
  text-align: center;
}
.editor-overlay.quiet p {
  margin: 0;
}
.editor-overlay.quiet p:first-child {
  font-size: 18px;
  letter-spacing: 0.08em;
  color: var(--fg-subtle);
}
.hint {
  font-size: 12px;
  color: var(--fg-subtle);
}
</style>
