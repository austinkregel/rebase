<script setup lang="ts">
import { reactive, ref } from 'vue'
import { PlusIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, DocumentIcon } from '@heroicons/vue/20/solid'
import { useProjectsStore, type Project } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { baseName, joinPath } from '@/services/paths'
import { openContextMenu, type ContextMenuItem } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import { confirm } from '@/services/confirm'
import FileTreeItem from './FileTreeItem.vue'
import SectionHeader from './ui/SectionHeader.vue'
import Button from './ui/Button.vue'
import InlineInput from './ui/InlineInput.vue'

const projects = useProjectsStore()
const session = useSessionStore()
const files = useFilesStore()

const creating = ref(false)
const name = ref('')

// Which projects are expanded (showing their roots). Project ids.
const expandedProjects = ref(new Set<string>())
// Listing errors keyed by root path.
const errors = reactive<Record<string, string>>({})

// Inline edit state (the inputs are <InlineInput>, which owns value + focus).
const renamingId = ref<string | null>(null)
const addingTo = ref<string | null>(null)
const creatingAt = ref<{ root: string; kind: 'file' | 'folder' } | null>(null)

function projectExpanded(p: Project) {
  return expandedProjects.value.has(p.id)
}
function rootExpanded(root: string) {
  return files.expanded.has(root)
}

function startNewProject() {
  const seg = files.browseRoot.replace(/[/\\]$/, '').split(/[/\\]/).pop()
  name.value = seg || 'project'
  creating.value = true
}

async function saveNewProject() {
  if (!session.activeClientId || !name.value.trim()) return
  const p = await projects.create({
    name: name.value.trim(),
    controlPlane: session.selectedControlPlane?.name ?? null,
    clientId: session.activeClientId,
    rootPaths: [],
  })
  creating.value = false
  name.value = ''
  expandedProjects.value.add(p.id)
}

async function toggleProject(p: Project) {
  if (projectExpanded(p)) {
    expandedProjects.value.delete(p.id)
    return
  }
  expandedProjects.value.add(p.id)
  // Expand + load each root so opening a project reveals its trees.
  for (const root of p.rootPaths) {
    if (!rootExpanded(root)) await toggleRoot(p.clientId, root)
  }
}

async function toggleRoot(clientId: string, root: string) {
  delete errors[root]
  try {
    await files.toggleDir(clientId, root)
  } catch (err) {
    errors[root] = err instanceof Error ? err.message : String(err)
  }
}

async function refreshRoot(clientId: string, root: string) {
  delete errors[root]
  try {
    await files.loadDir(clientId, root)
  } catch (err) {
    errors[root] = err instanceof Error ? err.message : String(err)
  }
}

function startRename(p: Project) {
  renamingId.value = p.id
}
async function commitRename(p: Project, value: string) {
  renamingId.value = null
  await projects.rename(p.id, value)
}

function startAddRoot(p: Project) {
  expandedProjects.value.add(p.id)
  addingTo.value = p.id
}
async function commitAddRoot(p: Project, path: string) {
  addingTo.value = null
  if (!path) return
  await projects.addRoot(p.id, path)
  await toggleRoot(p.clientId, path) // expand the freshly added root
}

async function startCreate(clientId: string, root: string, kind: 'file' | 'folder') {
  if (!rootExpanded(root)) await toggleRoot(clientId, root)
  creatingAt.value = { root, kind }
}
async function commitCreate(clientId: string, value: string) {
  const ctx = creatingAt.value
  creatingAt.value = null
  if (!ctx || !value) return
  try {
    const target = joinPath(ctx.root, value)
    if (ctx.kind === 'folder') await files.createDirectory(clientId, target, ctx.root)
    else await files.createFile(clientId, target, ctx.root)
  } catch (err) {
    errors[ctx.root] = err instanceof Error ? err.message : String(err)
  }
}

async function confirmDelete(p: Project) {
  const ok = await confirm({
    title: 'Delete project',
    message: `Remove the project "${p.name}"?\nThis only deletes the saved workspace, not any files.`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (ok) await projects.remove(p.id)
}

function projectMenu(event: MouseEvent, p: Project) {
  openContextMenu(event, [
    { label: 'Open', action: () => projects.open(p.id) },
    { label: 'Rename', action: () => void startRename(p) },
    { label: 'Add Directory…', action: () => void startAddRoot(p) },
    ...menuItemsFor('project/context', { projectId: p.id, name: p.name, clientId: p.clientId, rootPaths: p.rootPaths }),
    { label: 'Delete Project', action: () => void confirmDelete(p), danger: true, separator: true },
  ])
}

function rootMenu(event: MouseEvent, p: Project, root: string) {
  const items: ContextMenuItem[] = [
    { label: 'New File', action: () => void startCreate(p.clientId, root, 'file') },
    { label: 'New Folder', action: () => void startCreate(p.clientId, root, 'folder') },
    { label: 'Refresh', action: () => void refreshRoot(p.clientId, root) },
    ...menuItemsFor('projectRoot/context', { projectId: p.id, clientId: p.clientId, root }),
    {
      label: 'Remove from Project',
      action: () => {
        files.expanded.delete(root)
        void projects.removeRoot(p.id, root)
      },
      danger: true,
      separator: true,
    },
  ]
  openContextMenu(event, items)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <SectionHeader>
      projects
      <template #actions>
        <Button
          variant="ghost"
          :disabled="!session.activeClientId"
          title="save the current server as a project"
          @click="startNewProject"
        >
          <PlusIcon class="size-3.5" /> new
        </Button>
      </template>
    </SectionHeader>

    <form v-if="creating" class="flex flex-col gap-2 border-b border-line p-3" @submit.prevent="saveNewProject">
      <input
        v-model="name"
        class="w-full rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
        placeholder="project name"
        autofocus
      />
      <p class="text-xs text-subtle">{{ session.activeClientId || 'no server' }} · {{ files.browseRoot }}</p>
      <div class="flex gap-2">
        <Button variant="primary" type="submit">Save</Button>
        <Button variant="ghost" type="button" @click="creating = false">Cancel</Button>
      </div>
    </form>

    <div class="flex-1 overflow-auto py-1">
      <p v-if="!projects.projects.length" class="mx-3 my-2 text-sm text-subtle">
        No projects yet — browse to a folder in Files, then save it here.
      </p>

      <template v-for="p in projects.projects" :key="p.id">
        <!-- project row -->
        <div
          class="group flex w-full items-center gap-1 px-2 py-[5px] text-muted hover:bg-hover"
          :class="{ 'bg-active text-fg': p.id === projects.activeId }"
          @contextmenu.prevent="projectMenu($event, p)"
        >
          <button class="shrink-0 p-0.5 text-subtle hover:text-fg" @click="toggleProject(p)">
            <ChevronRightIcon class="size-3 transition-transform" :class="{ 'rotate-90': projectExpanded(p) }" />
          </button>
          <component :is="projectExpanded(p) ? FolderOpenIcon : FolderIcon" class="size-3.5 shrink-0 text-subtle" />
          <InlineInput
            v-if="renamingId === p.id"
            :initial="p.name"
            @commit="commitRename(p, $event)"
            @cancel="renamingId = null"
          />
          <button
            v-else
            class="flex min-w-0 flex-1 flex-col overflow-hidden text-left"
            :title="`${p.clientId} · ${p.rootPaths.join(', ')}`"
            @click="projects.open(p.id)"
          >
            <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">{{ p.name }}</span>
            <span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-subtle">
              {{ p.clientId }} · {{ p.rootPaths.length }} root{{ p.rootPaths.length === 1 ? '' : 's' }}
            </span>
          </button>
        </div>

        <!-- project body: each root as a directory tree -->
        <template v-if="projectExpanded(p)">
          <InlineInput
            v-if="addingTo === p.id"
            class="py-0.5 pl-6 pr-2"
            :icon="FolderIcon"
            placeholder="/path/to/directory"
            @commit="commitAddRoot(p, $event)"
            @cancel="addingTo = null"
          />

          <template v-for="root in p.rootPaths" :key="root">
            <!-- root header -->
            <button
              class="flex w-full items-center gap-1 py-0.5 pl-4 pr-2 text-left hover:bg-hover"
              :title="root"
              @click="toggleRoot(p.clientId, root)"
              @contextmenu.prevent="rootMenu($event, p, root)"
            >
              <ChevronRightIcon class="size-3 shrink-0 text-subtle transition-transform" :class="{ 'rotate-90': rootExpanded(root) }" />
              <component :is="rootExpanded(root) ? FolderOpenIcon : FolderIcon" class="size-3.5 shrink-0 text-subtle" />
              <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">{{ baseName(root) || root }}</span>
            </button>

            <template v-if="rootExpanded(root)">
              <p v-if="errors[root]" class="mx-3 my-1 text-xs text-red">{{ errors[root] }}</p>
              <InlineInput
                v-if="creatingAt && creatingAt.root === root"
                class="py-0.5 pl-9 pr-2"
                :icon="creatingAt.kind === 'folder' ? FolderIcon : DocumentIcon"
                :placeholder="creatingAt.kind === 'folder' ? 'folder name' : 'file name'"
                @commit="commitCreate(p.clientId, $event)"
                @cancel="creatingAt = null"
              />
              <p
                v-else-if="files.tree[root] && files.tree[root].length === 0 && !errors[root]"
                class="mx-3 my-1 text-sm text-subtle"
              >
                empty
              </p>
              <FileTreeItem
                v-for="entry in files.tree[root]"
                :key="entry.name"
                :client-id="p.clientId"
                :parent-path="root"
                :entry="entry"
                :depth="2"
              />
            </template>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>
