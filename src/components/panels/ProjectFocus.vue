<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  XMarkIcon,
  PencilSquareIcon,
  PlusIcon,
} from '@heroicons/vue/20/solid'
import { useProjectsStore } from '@/stores/projects'
import { useAgentsStore } from '@/stores/agents'
import { useGitStore } from '@/stores/git'
import { useFilesStore } from '@/stores/files'
import { baseName } from '@/services/paths'
import SectionHeader from '../ui/SectionHeader.vue'
import IconButton from '../ui/IconButton.vue'
import Badge from '../ui/Badge.vue'
import InlineInput from '../ui/InlineInput.vue'
import FileTreeItem from '../FileTreeItem.vue'

// The Project (IDE) focus tab: the single project you are in — its one server,
// its git state, the scope the agent is confined to, and its roots as trees.
// Present only in project mode (the view registration gates visibility), so
// `focused` is expected to be non-null while this renders.
const projects = useProjectsStore()
const agents = useAgentsStore()
const gitStore = useGitStore()
const files = useFilesStore()

const project = computed(() => projects.focused)
const clientId = computed(() => project.value?.clientId ?? '')
const roots = computed(() => project.value?.rootPaths ?? [])

const online = computed(() => agents.isOnline(clientId.value))
const stats = computed(() => (clientId.value ? agents.statsFor(clientId.value) : undefined))
const cpu = computed(() => (typeof stats.value?.cpu === 'number' ? Math.round(stats.value.cpu) : null))
const mem = computed(() => {
  const m = stats.value?.mem
  if (!m?.used || !m?.total) return null
  return Math.round((m.used / m.total) * 100)
})

const git = computed(() => (clientId.value ? gitStore.statusFor(clientId.value) : null))

const renaming = ref(false)
function commitRename(name: string) {
  if (project.value) void projects.rename(project.value.id, name)
  renaming.value = false
}

// Load git + expand the roots whenever the focused project (or its server) changes.
watch(
  () => [project.value?.id, clientId.value] as const,
  () => {
    const p = project.value
    if (!p || !clientId.value) return
    if (p.rootPaths[0]) void gitStore.refresh(clientId.value, p.rootPaths[0])
    for (const root of p.rootPaths) void files.expand(clientId.value, root)
  },
  { immediate: true },
)

onMounted(() => {
  const p = project.value
  if (p && clientId.value) for (const root of p.rootPaths) void files.expand(clientId.value, root)
})

function toggleRoot(root: string) {
  if (files.isExpanded(clientId.value, root)) files.collapse(clientId.value, root)
  else void files.expand(clientId.value, root)
}
function rootEntries(root: string) {
  return files.entriesFor(clientId.value, root)
}

function startAddRoot() {
  // Adding roots is owned by the Projects list's inline flow; the empty-state
  // link routes the user there rather than duplicating the input here.
  if (project.value) projects.open(project.value.id)
}
</script>

<template>
  <div v-if="project" class="flex h-full min-h-0 flex-col bg-surface">
    <SectionHeader>
      project
      <template #actions>
        <IconButton
          :icon="XMarkIcon"
          label="exit project mode"
          variant="plain"
          size="lg"
          title="Exit project mode"
          @click="projects.exitProjectMode()"
        />
      </template>
    </SectionHeader>

    <!-- Header block: name, server telemetry, git, agent scope. -->
    <div class="flex flex-col gap-1 border-b border-line px-3 py-2">
      <div class="flex items-center gap-1.5">
        <span class="text-accent">◆</span>
        <InlineInput v-if="renaming" :initial="project.name" @commit="commitRename" @cancel="renaming = false" />
        <template v-else>
          <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">{{ project.name }}</span>
          <IconButton :icon="PencilSquareIcon" label="rename project" variant="plain" size="sm" title="Rename" @click="renaming = true" />
        </template>
      </div>

      <div class="flex items-center gap-1.5 text-xs text-subtle">
        <span class="size-2 shrink-0 rounded-full" :class="online ? 'bg-green' : 'bg-subtle'" />
        <span class="overflow-hidden text-ellipsis whitespace-nowrap">{{ agents.displayName(clientId) }}</span>
        <template v-if="online && (cpu !== null || mem !== null)">
          <span v-if="cpu !== null">· cpu {{ cpu }}%</span>
          <span v-if="mem !== null">· mem {{ mem }}%</span>
        </template>
        <span v-else-if="!online" class="text-yellow">· offline</span>
      </div>

      <div class="flex items-center gap-1.5 text-xs text-subtle">
        <span v-if="git">⎇ {{ git.branch || 'detached' }}<span v-if="git.dirty" class="text-yellow"> ✎{{ git.dirty }} changed</span></span>
        <span v-else>⎇ —</span>
      </div>

      <div
        class="flex items-center gap-1 text-xs text-subtle"
        :title="roots.length ? `Agent confined to:\n${roots.join('\n')}` : 'No roots — the agent has nothing in scope'"
      >
        <Badge uppercase>scope</Badge>
        <span v-if="roots.length">{{ roots.length }} root{{ roots.length === 1 ? '' : 's' }} · agent confined</span>
        <span v-else class="text-yellow">no roots</span>
      </div>
    </div>

    <!-- Roots as trees. -->
    <div class="min-h-0 flex-1 overflow-auto py-1">
      <p v-if="!roots.length" class="mx-3 my-2 text-sm text-subtle">
        No directories —
        <button class="text-accent hover:underline" @click="startAddRoot">add one in the Projects list</button>.
      </p>

      <template v-for="root in roots" :key="root">
        <button
          class="flex w-full items-center gap-1 py-0.5 pl-2 pr-2 text-left hover:bg-hover"
          :title="root"
          @click="toggleRoot(root)"
        >
          <ChevronRightIcon class="size-3 shrink-0 text-subtle transition-transform" :class="{ 'rotate-90': files.isExpanded(clientId, root) }" />
          <component :is="files.isExpanded(clientId, root) ? FolderOpenIcon : FolderIcon" class="size-3.5 shrink-0 text-subtle" />
          <span class="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-fg">{{ baseName(root) || root }}</span>
        </button>

        <template v-if="files.isExpanded(clientId, root)">
          <p v-if="!online" class="mx-3 my-1 text-sm text-subtle">{{ agents.displayName(clientId) }} is offline</p>
          <p v-else-if="rootEntries(root)?.length === 0" class="mx-3 my-1 text-sm text-subtle">empty</p>
          <FileTreeItem
            v-for="entry in rootEntries(root)"
            :key="entry.name"
            :client-id="clientId"
            :parent-path="root"
            :entry="entry"
            :depth="1"
          />
        </template>
      </template>
    </div>

    <div class="flex items-center justify-between border-t border-line px-3 py-1.5 text-xs text-subtle">
      <span>project mode</span>
      <button class="flex items-center gap-1 hover:text-fg" @click="projects.exitProjectMode()">
        <PlusIcon class="size-3.5 rotate-45" /> exit
      </button>
    </div>
  </div>
</template>
