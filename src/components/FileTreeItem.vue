<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, DocumentIcon } from '@heroicons/vue/20/solid'
import { useFilesStore } from '@/stores/files'
import { joinPath } from '@/services/paths'
import { openContextMenu, type ContextMenuItem } from '@/services/contextMenu'
import { confirm } from '@/services/confirm'
import type { DirListEntry } from '@/transport/types'

const props = defineProps<{
  clientId: string
  parentPath: string
  entry: DirListEntry
  depth: number
  /** Optional extra context-menu items for folders, built by the host
   *  (e.g. the File explorer's "Add to Project as Root"). */
  folderMenu?: (path: string) => ContextMenuItem[]
}>()

const files = useFilesStore()
const error = ref<string | null>(null)

const path = computed(() => joinPath(props.parentPath, props.entry.name))
const isDir = computed(() => props.entry.type === 'dir')
const isExpanded = computed(() => files.expanded.has(path.value))
const children = computed(() => files.tree[path.value])
const isActive = computed(() => files.activePath === path.value)
const isOpen = computed(() => files.openFiles.some((f) => f.path === path.value))

// --- inline edit state ---
const renaming = ref(false)
const creating = ref<null | 'file' | 'folder'>(null)
const nameInput = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

async function activate() {
  error.value = null
  try {
    if (isDir.value) await files.toggleDir(props.clientId, path.value)
    else await files.openFile(props.clientId, path.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function focusInput() {
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}

function report(err: unknown) {
  error.value = err instanceof Error ? err.message : String(err)
}

async function startRename() {
  nameInput.value = props.entry.name
  renaming.value = true
  await focusInput()
}

async function commitRename() {
  const name = nameInput.value.trim()
  renaming.value = false
  if (!name || name === props.entry.name) return
  try {
    await files.renameEntry(props.clientId, path.value, joinPath(props.parentPath, name), [props.parentPath])
  } catch (err) {
    report(err)
  }
}

async function startCreate(kind: 'file' | 'folder') {
  if (!isExpanded.value) await files.toggleDir(props.clientId, path.value).catch(() => {})
  nameInput.value = ''
  creating.value = kind
  await focusInput()
}

async function commitCreate() {
  const name = nameInput.value.trim()
  const kind = creating.value
  creating.value = null
  if (!name || !kind) return
  try {
    if (kind === 'folder') await files.createDirectory(props.clientId, joinPath(path.value, name), path.value)
    else await files.createFile(props.clientId, joinPath(path.value, name), path.value)
  } catch (err) {
    report(err)
  }
}

async function doDelete() {
  const ok = await confirm({
    title: `Delete ${isDir.value ? 'folder' : 'file'}`,
    message: `Delete "${props.entry.name}"?${isDir.value ? '\nThis removes the folder and everything in it.' : ''}`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await files.removeEntry(props.clientId, path.value, isDir.value, props.parentPath)
  } catch (err) {
    report(err)
  }
}

function onContextMenu(event: MouseEvent) {
  const items: ContextMenuItem[] = isDir.value
    ? [
        { label: 'New File', action: () => void startCreate('file') },
        { label: 'New Folder', action: () => void startCreate('folder') },
        { label: 'Rename', action: () => void startRename() },
        ...(props.folderMenu?.(path.value) ?? []),
        { label: 'Delete', action: () => void doDelete(), danger: true, separator: true },
      ]
    : [
        { label: 'Open', action: () => void activate() },
        { label: 'Rename', action: () => void startRename() },
        { label: 'Delete', action: () => void doDelete(), danger: true, separator: true },
      ]
  openContextMenu(event, items)
}
</script>

<template>
  <div>
    <!-- inline rename replaces the row label -->
    <div
      v-if="renaming"
      class="flex items-center gap-1.5 py-[3px] pr-2"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
    >
      <span class="size-3 shrink-0" />
      <component :is="isDir ? FolderIcon : DocumentIcon" class="size-3.5 shrink-0 text-subtle" />
      <input
        ref="inputEl"
        v-model="nameInput"
        class="min-w-0 flex-1 rounded border border-accent bg-elevated px-1 text-[12.5px] text-fg outline-none"
        spellcheck="false"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="renaming = false"
        @blur="commitRename"
      />
    </div>

    <button
      v-else
      class="flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap py-[3px] pr-2 text-left text-[12.5px] hover:bg-hover hover:text-fg"
      :class="isActive ? 'bg-active text-fg' : isOpen ? 'text-fg' : 'text-muted'"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      :title="error ?? path"
      @click="activate"
      @contextmenu="onContextMenu"
    >
      <ChevronRightIcon
        v-if="isDir"
        class="size-3 shrink-0 text-subtle transition-transform"
        :class="{ 'rotate-90': isExpanded }"
      />
      <span v-else class="size-3 shrink-0" />
      <component
        :is="isDir ? (isExpanded ? FolderOpenIcon : FolderIcon) : DocumentIcon"
        class="size-3.5 shrink-0 text-subtle"
      />
      <span class="overflow-hidden text-ellipsis">{{ entry.name }}</span>
      <span v-if="entry.isSymlink" class="text-[10px] text-subtle">→</span>
    </button>

    <div
      v-if="error"
      class="whitespace-normal py-0.5 pr-2 text-[11px] text-red"
      :style="{ paddingLeft: `${24 + depth * 14}px` }"
    >
      {{ error }}
    </div>

    <template v-if="isDir && isExpanded">
      <!-- inline new-file/new-folder input -->
      <div
        v-if="creating"
        class="flex items-center gap-1.5 py-[3px] pr-2"
        :style="{ paddingLeft: `${8 + (depth + 1) * 14}px` }"
      >
        <span class="size-3 shrink-0" />
        <component :is="creating === 'folder' ? FolderIcon : DocumentIcon" class="size-3.5 shrink-0 text-subtle" />
        <input
          ref="inputEl"
          v-model="nameInput"
          :placeholder="creating === 'folder' ? 'folder name' : 'file name'"
          class="min-w-0 flex-1 rounded border border-accent bg-elevated px-1 text-[12.5px] text-fg outline-none"
          spellcheck="false"
          @keydown.enter.prevent="commitCreate"
          @keydown.esc.prevent="creating = null"
          @blur="commitCreate"
        />
      </div>

      <FileTreeItem
        v-for="child in children"
        :key="child.name"
        :client-id="clientId"
        :parent-path="path"
        :entry="child"
        :depth="depth + 1"
      />
    </template>
  </div>
</template>
