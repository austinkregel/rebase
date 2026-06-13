<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowPathIcon, DocumentPlusIcon, FolderIcon, FolderPlusIcon } from '@heroicons/vue/20/solid'
import { useFilesStore } from '@/stores/files'
import { useSessionStore } from '@/stores/session'
import { joinPath } from '@/services/paths'
import FileTreeItem from './FileTreeItem.vue'
import SectionHeader from './ui/SectionHeader.vue'
import IconButton from './ui/IconButton.vue'
import InlineInput from './ui/InlineInput.vue'

// The File explorer: a plain, single-root filesystem browser. Point it anywhere
// via the path box; it is independent of the persisted project workspace.
const files = useFilesStore()
const session = useSessionStore()
const error = ref<string | null>(null)
const loading = ref(false)
const pathInput = ref(files.browseRoot)

// Inline new file/folder at the browse root.
const creating = ref<null | 'file' | 'folder'>(null)

const entries = computed(() => files.tree[files.browseRoot])

async function loadRoot() {
  if (!session.activeClientId) return
  error.value = null
  loading.value = true
  try {
    await files.loadDir(session.activeClientId, files.browseRoot)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function go() {
  files.setBrowseRoot(pathInput.value.trim() || files.browseRoot)
  void loadRoot()
}

// Keep the input synced and (re)load when the server or root changes.
watch(
  () => files.browseRoot,
  (root) => {
    pathInput.value = root
  },
)
watch(
  () => [session.activeClientId, files.browseRoot],
  () => {
    if (session.activeClientId && !files.tree[files.browseRoot]) void loadRoot()
  },
  { immediate: true },
)

function startCreate(kind: 'file' | 'folder') {
  creating.value = kind
}

async function commitCreate(name: string) {
  const kind = creating.value
  creating.value = null
  if (!name || !kind || !session.activeClientId) return
  try {
    const target = joinPath(files.browseRoot, name)
    if (kind === 'folder') await files.createDirectory(session.activeClientId, target, files.browseRoot)
    else await files.createFile(session.activeClientId, target, files.browseRoot)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <SectionHeader>
      files
      <template #actions>
        <IconButton :icon="DocumentPlusIcon" size="md" label="new file" :disabled="!session.activeClientId" @click="startCreate('file')" />
        <IconButton :icon="FolderPlusIcon" size="md" label="new folder" :disabled="!session.activeClientId" @click="startCreate('folder')" />
        <IconButton :icon="ArrowPathIcon" size="md" label="refresh" :disabled="!session.activeClientId" @click="loadRoot" />
      </template>
    </SectionHeader>

    <form class="flex-shrink-0 border-b border-line p-2" @submit.prevent="go">
      <input
        v-model="pathInput"
        class="w-full rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent disabled:opacity-50"
        spellcheck="false"
        autocomplete="off"
        placeholder="/path/to/browse"
        :disabled="!session.activeClientId"
      />
    </form>

    <div class="flex-1 overflow-auto py-1">
      <p v-if="!session.activeClientId" class="mx-3 my-2 text-sm text-subtle">
        connect to a machine to browse files
      </p>
      <p v-else-if="loading" class="mx-3 my-2 text-sm text-subtle">loading…</p>
      <p v-else-if="error" class="mx-3 my-2 text-sm text-red">{{ error }}</p>
      <template v-else>
        <InlineInput
          v-if="creating"
          class="px-2 py-0.5"
          :icon="FolderIcon"
          :placeholder="creating === 'folder' ? 'folder name' : 'file name'"
          @commit="commitCreate"
          @cancel="creating = null"
        />
        <p v-if="entries && entries.length === 0" class="mx-3 my-2 text-sm text-subtle">empty directory</p>
        <FileTreeItem
          v-for="entry in entries"
          :key="entry.name"
          :client-id="session.activeClientId"
          :parent-path="files.browseRoot"
          :entry="entry"
          :depth="0"
        />
      </template>
    </div>
  </div>
</template>
