<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, DocumentIcon } from '@heroicons/vue/20/solid'
import { useFilesStore } from '@/stores/files'
import { joinPath } from '@/services/paths'
import { openContextMenu, type ContextMenuItem } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import { confirm } from '@/services/confirm'
import InlineInput from './ui/InlineInput.vue'
import type { DirListEntry } from '@/transport/types'

const props = defineProps<{
  clientId: string
  parentPath: string
  entry: DirListEntry
  depth: number
}>()

const files = useFilesStore()
const error = ref<string | null>(null)

const path = computed(() => joinPath(props.parentPath, props.entry.name))
const isDir = computed(() => props.entry.type === 'dir')
const isExpanded = computed(() => files.isExpanded(props.clientId, path.value))
const children = computed(() => files.entriesFor(props.clientId, path.value))
const isActive = computed(() => files.activePath === path.value)
const isOpen = computed(() => files.openFiles.some((f) => f.path === path.value))

// --- inline edit state (the inputs themselves are <InlineInput>) ---
const renaming = ref(false)
const creating = ref<null | 'file' | 'folder'>(null)

async function activate() {
  error.value = null
  try {
    if (isDir.value) await files.toggleDir(props.clientId, path.value)
    else await files.openFile(props.clientId, path.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function report(err: unknown) {
  error.value = err instanceof Error ? err.message : String(err)
}

async function commitRename(name: string) {
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
  creating.value = kind
}

async function commitCreate(name: string) {
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
  const ctx = { clientId: props.clientId, path: path.value, name: props.entry.name, isDir: isDir.value }
  const items: ContextMenuItem[] = isDir.value
    ? [
        { label: 'New File', action: () => void startCreate('file') },
        { label: 'New Folder', action: () => void startCreate('folder') },
        { label: 'Rename', action: () => (renaming.value = true) },
        ...menuItemsFor('folder/context', ctx),
        { label: 'Delete', action: () => void doDelete(), danger: true, separator: true },
      ]
    : [
        { label: 'Open', action: () => void activate() },
        { label: 'Rename', action: () => (renaming.value = true) },
        ...menuItemsFor('file/context', ctx),
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
      class="flex items-center gap-1.5 py-0.5 pr-2"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
    >
      <span class="size-3 shrink-0" />
      <InlineInput
        :initial="entry.name"
        :icon="isDir ? FolderIcon : DocumentIcon"
        @commit="commitRename"
        @cancel="renaming = false"
      />
    </div>

    <button
      v-else
      class="flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap py-0.5 pr-2 text-left text-sm hover:bg-hover hover:text-fg"
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
      <span v-if="entry.isSymlink" class="text-2xs text-subtle">→</span>
    </button>

    <div
      v-if="error"
      class="whitespace-normal py-0.5 pr-2 text-xs text-red"
      :style="{ paddingLeft: `${24 + depth * 14}px` }"
    >
      {{ error }}
    </div>

    <template v-if="isDir && isExpanded">
      <!-- inline new-file/new-folder input -->
      <div
        v-if="creating"
        class="flex items-center gap-1.5 py-0.5 pr-2"
        :style="{ paddingLeft: `${8 + (depth + 1) * 14}px` }"
      >
        <span class="size-3 shrink-0" />
        <InlineInput
          :icon="creating === 'folder' ? FolderIcon : DocumentIcon"
          :placeholder="creating === 'folder' ? 'folder name' : 'file name'"
          @commit="commitCreate"
          @cancel="creating = null"
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
