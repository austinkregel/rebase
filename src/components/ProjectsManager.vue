<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { PlusIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, DocumentIcon } from '@heroicons/vue/20/solid'
import { useProjectsStore, type Project } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { useAgentsStore } from '@/stores/agents'
import { baseName, joinPath } from '@/services/paths'
import { openContextMenu, type ContextMenuItem } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import { confirm } from '@/services/confirm'
import FileTreeItem from './FileTreeItem.vue'
import SectionHeader from './ui/SectionHeader.vue'
import Badge from './ui/Badge.vue'
import Button from './ui/Button.vue'
import InlineInput from './ui/InlineInput.vue'
import IconButton from './ui/IconButton.vue'

const projects = useProjectsStore()
const session = useSessionStore()
const files = useFilesStore()
const agents = useAgentsStore()

const creating = ref(false)
const name = ref('')
const newRoot = ref('')

// Listing errors and in-flight listings, keyed by "clientId\0root" — the same
// path can appear under projects on different servers.
const errors = reactive<Record<string, string>>({})
const loading = reactive<Record<string, boolean>>({})
const rootKey = (clientId: string, root: string) => `${clientId}\0${root}`

// Inline edit state (the inputs are <InlineInput>, which owns value + focus).
const renamingId = ref<string | null>(null)
const addingTo = ref<string | null>(null)
const creatingAt = ref<{ clientId: string; root: string; kind: 'file' | 'folder' } | null>(null)

function projectExpanded(p: Project) {
  return projects.expandedIds.has(p.id)
}
function rootExpanded(clientId: string, root: string) {
  return files.isExpanded(clientId, root)
}
function rootEntries(clientId: string, root: string) {
  return files.entriesFor(clientId, root)
}

function startNewProject() {
  const seg = files.browseRoot.replace(/[/\\]$/, '').split(/[/\\]/).pop()
  name.value = seg || 'project'
  newRoot.value = files.browseRoot
  creating.value = true
}

async function saveNewProject() {
  if (!session.activeClientId || !name.value.trim()) return
  const root = newRoot.value.trim()
  const p = await projects.create({
    name: name.value.trim(),
    controlPlane: session.selectedControlPlane?.name ?? null,
    clientId: session.activeClientId,
    // The form offers a starting directory; without one the project opens empty
    // and the user adds roots from its context menu.
    rootPaths: root ? [root] : [],
  })
  creating.value = false
  name.value = ''
  newRoot.value = ''
  projects.setExpanded(p.id, true)
  await revealRoots(p)
}

/** Opening a project selects its server and shows its trees — the point of the
 *  click is to see the files, so don't leave the roots collapsed or unloaded. */
async function openProject(p: Project) {
  projects.open(p.id)
  projects.setExpanded(p.id, true)
  await revealRoots(p)
}

async function toggleProject(p: Project) {
  if (projectExpanded(p)) {
    projects.setExpanded(p.id, false)
    return
  }
  projects.setExpanded(p.id, true)
  await revealRoots(p)
}

/** Expand every root of a project and make sure each listing is actually loaded
 *  — a root can be flagged expanded from a previous session while its listing
 *  was never fetched (or was dropped when the socket went down). */
async function revealRoots(p: Project) {
  await Promise.all(p.rootPaths.map((root) => expandRoot(p.clientId, root)))
}

async function expandRoot(clientId: string, root: string) {
  const key = rootKey(clientId, root)
  delete errors[key]
  loading[key] = true
  try {
    await files.expand(clientId, root)
  } catch (err) {
    errors[key] = err instanceof Error ? err.message : String(err)
  } finally {
    loading[key] = false
  }
}

async function toggleRoot(clientId: string, root: string) {
  if (rootExpanded(clientId, root)) {
    files.collapse(clientId, root)
    return
  }
  await expandRoot(clientId, root)
}

/** A project on a server the control plane isn't listing. Its rows still render
 *  — the workspace is a saved thing, not a live one — but they say so. */
function projectOffline(p: Project) {
  return !agents.isOnline(p.clientId)
}

/** A connected agent whose clientId differs from this project's only by case:
 *  the same machine, re-registered. Returns '' when there's no such candidate,
 *  so the template can use it as both the condition and the value. */
function likelyRename(p: Project): string {
  const match = agents.sortedAgents.find(
    (a) => a.clientId !== p.clientId && a.clientId.toLowerCase() === p.clientId.toLowerCase(),
  )
  return match?.clientId ?? ''
}

// Heal on reconnect: a project whose server was down has no listings, and the
// user shouldn't have to re-click to get them once it's back. Fires the first
// time a client_list marks each server online, and again on every return.
let wasOnline = new Set<string>()
watch(
  () => projects.projects.filter((p) => agents.isOnline(p.clientId)).map((p) => p.clientId),
  (ids) => {
    const now = new Set(ids)
    for (const p of projects.projects) {
      if (now.has(p.clientId) && !wasOnline.has(p.clientId) && projectExpanded(p)) void revealRoots(p)
    }
    wasOnline = now
  },
)

async function refreshRoot(clientId: string, root: string) {
  const key = rootKey(clientId, root)
  delete errors[key]
  loading[key] = true
  try {
    await files.loadDir(clientId, root)
  } catch (err) {
    errors[key] = err instanceof Error ? err.message : String(err)
  } finally {
    loading[key] = false
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
  projects.setExpanded(p.id, true)
  addingTo.value = p.id
}
async function commitAddRoot(p: Project, path: string) {
  addingTo.value = null
  if (!path) return
  // addRoot normalizes ("/srv/app/" → "/srv/app"); expand *that* key, or the
  // tree would be cached under a path the template never looks up.
  const root = await projects.addRoot(p.id, path)
  if (root) await expandRoot(p.clientId, root)
}

async function startCreate(clientId: string, root: string, kind: 'file' | 'folder') {
  if (!rootExpanded(clientId, root)) await expandRoot(clientId, root)
  creatingAt.value = { clientId, root, kind }
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
    errors[rootKey(clientId, ctx.root)] = err instanceof Error ? err.message : String(err)
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

/** "Move to <server>" for every other connected agent. A project's roots are
 *  plain paths, so repointing one is just an id swap — the recovery when an
 *  agent comes back under a different clientId and the saved project is left
 *  addressing a machine the control plane never lists. */
function moveTargets(p: Project): ContextMenuItem[] {
  const others = agents.sortedAgents.filter((a) => a.clientId !== p.clientId)
  // Differing only by case is almost certainly the same box after a rename or
  // reinstall, so offer it first and name what it replaces.
  const likely = others.find((a) => a.clientId.toLowerCase() === p.clientId.toLowerCase())
  const ordered = likely ? [likely, ...others.filter((a) => a !== likely)] : others
  return ordered.map((a, i) => ({
    label:
      a === likely
        ? `Move to ${a.hostname || a.clientId} (was “${p.clientId}”)`
        : `Move to ${a.hostname || a.clientId}`,
    separator: i === 0,
    action: () => void projects.moveToServer(p.id, a.clientId),
  }))
}

function projectMenu(event: MouseEvent, p: Project) {
  openContextMenu(event, [
    { label: 'Open', action: () => void openProject(p) },
    { label: 'Rename', action: () => void startRename(p) },
    { label: 'Add Directory…', action: () => void startAddRoot(p) },
    ...menuItemsFor('project/context', { projectId: p.id, name: p.name, clientId: p.clientId, rootPaths: p.rootPaths }),
    ...moveTargets(p),
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
        files.collapse(p.clientId, root)
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
        <IconButton
          :icon="PlusIcon"
          size="md"
          label="new"
          variant="ghost"
          :disabled="!session.activeClientId"
          @click="startNewProject"
        />
      </template>
    </SectionHeader>

    <form v-if="creating" class="flex flex-col gap-2 border-b border-line p-3" @submit.prevent="saveNewProject">
      <input
        v-model="name"
        class="w-full rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
        placeholder="project name"
        autofocus
      />
      <input
        v-model="newRoot"
        class="w-full rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
        spellcheck="false"
        autocomplete="off"
        placeholder="/path/to/directory"
      />
      <p class="text-xs text-subtle">{{ session.activeClientId || 'no server' }}</p>
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
            @click="openProject(p)"
          >
            <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">{{ p.name }}</span>
            <span class="flex items-center gap-1 overflow-hidden text-xs text-subtle">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap">
                {{ p.clientId }} · {{ p.rootPaths.length }} root{{ p.rootPaths.length === 1 ? '' : 's' }}
              </span>
              <Badge v-if="projectOffline(p)" uppercase>offline</Badge>
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

          <p v-if="!p.rootPaths.length && addingTo !== p.id" class="my-1 pl-6 pr-2 text-sm text-subtle">
            no directories —
            <button class="text-accent hover:underline" @click="startAddRoot(p)">add one</button>
          </p>

          <template v-for="root in p.rootPaths" :key="root">
            <!-- root header -->
            <button
              class="flex w-full items-center gap-1 py-0.5 pl-4 pr-2 text-left hover:bg-hover"
              :title="root"
              @click="toggleRoot(p.clientId, root)"
              @contextmenu.prevent="rootMenu($event, p, root)"
            >
              <ChevronRightIcon class="size-3 shrink-0 text-subtle transition-transform" :class="{ 'rotate-90': rootExpanded(p.clientId, root) }" />
              <component :is="rootExpanded(p.clientId, root) ? FolderOpenIcon : FolderIcon" class="size-3.5 shrink-0 text-subtle" />
              <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">{{ baseName(root) || root }}</span>
            </button>

            <template v-if="rootExpanded(p.clientId, root)">
              <!-- An unreachable server is a state, not a failure: say so quietly
                   and let the reconnect watcher fill the tree back in. -->
              <p v-if="projectOffline(p)" class="mx-3 my-1 whitespace-normal text-sm text-subtle">
                {{ agents.displayName(p.clientId) }} is offline<template v-if="likelyRename(p)">
                  — a connected server is named
                  <button
                    class="text-accent hover:underline"
                    @click="projects.moveToServer(p.id, likelyRename(p))"
                  >{{ likelyRename(p) }}</button>
                </template>
              </p>
              <p
                v-else-if="errors[rootKey(p.clientId, root)]"
                class="mx-3 my-1 whitespace-normal text-xs text-red"
              >
                {{ errors[rootKey(p.clientId, root)] }}
              </p>
              <InlineInput
                v-if="creatingAt && creatingAt.clientId === p.clientId && creatingAt.root === root"
                class="py-0.5 pl-9 pr-2"
                :icon="creatingAt.kind === 'folder' ? FolderIcon : DocumentIcon"
                :placeholder="creatingAt.kind === 'folder' ? 'folder name' : 'file name'"
                @commit="commitCreate(p.clientId, $event)"
                @cancel="creatingAt = null"
              />
              <!-- An expanded root always reports its state: loading, failed,
                   genuinely empty, or its entries — never a silent blank. The
                   offline case is already covered above, and prompting to
                   "load" a server that can't answer would just be a dead button.
                   Any entries cached before it went down still render below. -->
              <template v-if="!projectOffline(p)">
                <p v-if="loading[rootKey(p.clientId, root)]" class="mx-3 my-1 text-sm text-subtle">loading…</p>
                <p
                  v-else-if="rootEntries(p.clientId, root)?.length === 0 && !errors[rootKey(p.clientId, root)]"
                  class="mx-3 my-1 text-sm text-subtle"
                >
                  empty
                </p>
                <p
                  v-else-if="!rootEntries(p.clientId, root) && !errors[rootKey(p.clientId, root)]"
                  class="mx-3 my-1 text-sm text-subtle"
                >
                  not loaded —
                  <button class="text-accent hover:underline" @click="refreshRoot(p.clientId, root)">load</button>
                </p>
              </template>
              <FileTreeItem
                v-for="entry in rootEntries(p.clientId, root)"
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
