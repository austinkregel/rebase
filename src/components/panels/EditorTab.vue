<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { XMarkIcon } from '@heroicons/vue/20/solid'
import { useFilesStore } from '@/stores/files'
import { openContextMenu, type ContextMenuItem } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import { baseName } from '@/services/paths'

// Custom dockview tab: title + dirty dot + close, with a useful right-click menu.
// dockview-vue passes IDockviewPanelHeaderProps as `props.params`
// ({ api, containerApi, params }), the same wrapper the content panels get.
interface PanelApi {
  id: string
  title?: string
  close: () => void
  onDidTitleChange?: (cb: (e: { title: string }) => void) => { dispose: () => void }
  group?: { panels: { id: string; api: { close: () => void } }[] }
}
const props = defineProps<{
  params: { api: PanelApi; containerApi: unknown; params?: { path?: string; clientId?: string } }
}>()

const files = useFilesStore()

const api = computed(() => props.params.api)
const path = computed(() => props.params.params?.path ?? '')
const clientId = computed(() => props.params.params?.clientId ?? '')

// `api.title` is a plain getter — it doesn't re-render when a panel renames
// itself (e.g. a terminal adopting its name). Track dockview's title event so
// the tab adopts and live-updates the title; editors fall back to the basename.
const liveTitle = ref(props.params.api.title)
const stopTitle = props.params.api.onDidTitleChange?.((e) => (liveTitle.value = e.title))
onBeforeUnmount(() => stopTitle?.dispose())

const title = computed(() => liveTitle.value || baseName(path.value) || path.value)
const isEditor = computed(() => !!path.value) // editor tabs carry a path; terminals don't
const dirty = computed(() => {
  const f = files.openFiles.find((x) => x.clientId === clientId.value && x.path === path.value)
  return !!f && f.content !== f.savedContent
})

function close() {
  api.value?.close()
}
function siblings() {
  return [...(api.value?.group?.panels ?? [])]
}
function closeOthers() {
  for (const p of siblings()) if (p.id !== api.value?.id) p.api.close()
}
function closeAll() {
  for (const p of siblings()) p.api.close()
}
function copy(text: string) {
  void navigator.clipboard?.writeText(text)
}

function onMenu(e: MouseEvent) {
  const items: ContextMenuItem[] = [
    { label: 'Close', action: close },
    { label: 'Close Others', action: closeOthers, disabled: siblings().length <= 1 },
    { label: 'Close All', action: closeAll },
  ]
  if (isEditor.value) {
    items.push({ label: 'Copy Path', action: () => copy(path.value), separator: true })
    items.push({ label: 'Copy File Name', action: () => copy(title.value) })
  }
  items.push(...menuItemsFor('editorTab/context', { clientId: props.params.params?.clientId, path: path.value || undefined }))
  openContextMenu(e, items)
}
</script>

<template>
  <div
    class="group flex h-full items-center gap-1.5 px-2 text-sm"
    :title="path || title"
    @contextmenu.prevent="onMenu"
    @pointerdown.middle.prevent="close"
  >
    <span class="whitespace-nowrap">{{ title }}</span>
    <span v-if="dirty" class="size-1.5 rounded-full bg-yellow" title="unsaved changes" />
    <button
      class="flex shrink-0 text-subtle opacity-0 hover:text-fg group-hover:opacity-100"
      title="close"
      @pointerdown.stop
      @click.stop="close"
    >
      <XMarkIcon class="size-3" />
    </button>
  </div>
</template>
