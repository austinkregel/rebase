<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowPathIcon, DocumentPlusIcon, FolderPlusIcon } from '@heroicons/vue/20/solid'
import { useFilesStore } from '@/stores/files'
import { useSessionStore } from '@/stores/session'
import { useProjectsStore } from '@/stores/projects'
import { baseName, joinPath, normalizeRoot } from '@/services/paths'
import type { ContextMenuItem } from '@/services/contextMenu'
import FileTreeItem from './FileTreeItem.vue'

// The File explorer: a plain, single-root filesystem browser. Point it anywhere
// via the path box; it is independent of the persisted project workspace.
const files = useFilesStore()
const session = useSessionStore()
const projects = useProjectsStore()

const error = ref<string | null>(null)
const loading = ref(false)
const pathInput = ref(files.browseRoot)

// Inline new file/folder at the browse root.
const creating = ref<null | 'file' | 'folder'>(null)
const createName = ref('')
const createEl = ref<HTMLInputElement | null>(null)

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

async function startCreate(kind: 'file' | 'folder') {
  creating.value = kind
  createName.value = ''
  await nextTick()
  createEl.value?.focus()
}

async function commitCreate() {
  const name = createName.value.trim()
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

// Bridge from ad-hoc browsing to the persisted workspace: a folder can be added
// as a root to any saved project on this server, or seed a brand-new project.
function folderMenu(path: string): ContextMenuItem[] {
  const clientId = session.activeClientId
  if (!clientId) return []
  const root = normalizeRoot(path)
  const mine = projects.projects.filter((p) => p.clientId === clientId)
  const items: ContextMenuItem[] = mine.map((p) => ({
    label: `Add to "${p.name}"`,
    action: () => void projects.addRoot(p.id, path),
    disabled: p.rootPaths.includes(root),
  }))
  items.push({
    label: 'New Project from Folder',
    separator: mine.length > 0,
    action: () => void newProjectFromFolder(path),
  })
  return items
}

async function newProjectFromFolder(path: string) {
  const clientId = session.activeClientId
  if (!clientId) return
  const project = await projects.create({
    name: baseName(path) || 'project',
    controlPlane: session.selectedControlPlane?.name ?? null,
    clientId,
    rootPaths: [path],
  })
  projects.open(project.id)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex flex-shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
      <span class="flex-1 text-[10.5px] uppercase tracking-[0.12em] text-subtle">files</span>
      <button
        type="button"
        class="rounded p-1 text-subtle hover:bg-hover hover:text-fg disabled:opacity-50"
        title="new file"
        :disabled="!session.activeClientId"
        @click="startCreate('file')"
      >
        <DocumentPlusIcon class="size-4" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-subtle hover:bg-hover hover:text-fg disabled:opacity-50"
        title="new folder"
        :disabled="!session.activeClientId"
        @click="startCreate('folder')"
      >
        <FolderPlusIcon class="size-4" />
      </button>
      <button
        type="button"
        class="rounded p-1 text-subtle hover:bg-hover hover:text-fg disabled:opacity-50"
        title="refresh"
        :disabled="!session.activeClientId"
        @click="loadRoot"
      >
        <ArrowPathIcon class="size-4" />
      </button>
    </div>

    <form class="flex-shrink-0 border-b border-line p-2" @submit.prevent="go">
      <input
        v-model="pathInput"
        class="w-full rounded border border-line bg-elevated px-2 py-1 text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50"
        spellcheck="false"
        autocomplete="off"
        placeholder="/path/to/browse"
        :disabled="!session.activeClientId"
      />
    </form>

    <div class="flex-1 overflow-auto py-1">
      <p v-if="!session.activeClientId" class="mx-3 my-2 text-[12px] text-subtle">
        connect to a machine to browse files
      </p>
      <p v-else-if="loading" class="mx-3 my-2 text-[12px] text-subtle">loading…</p>
      <p v-else-if="error" class="mx-3 my-2 text-[12px] text-red">{{ error }}</p>
      <template v-else>
        <div v-if="creating" class="flex items-center gap-1.5 px-2 py-[3px]">
          <span class="size-3 shrink-0" />
          <input
            ref="createEl"
            v-model="createName"
            :placeholder="creating === 'folder' ? 'folder name' : 'file name'"
            class="min-w-0 flex-1 rounded border border-accent bg-elevated px-1 text-[12.5px] text-fg outline-none"
            spellcheck="false"
            @keydown.enter.prevent="commitCreate"
            @keydown.esc.prevent="creating = null"
            @blur="commitCreate"
          />
        </div>
        <p v-if="entries && entries.length === 0" class="mx-3 my-2 text-[12px] text-subtle">empty directory</p>
        <FileTreeItem
          v-for="entry in entries"
          :key="entry.name"
          :client-id="session.activeClientId"
          :parent-path="files.browseRoot"
          :entry="entry"
          :depth="0"
          :folder-menu="folderMenu"
        />
      </template>
    </div>
  </div>
</template>
