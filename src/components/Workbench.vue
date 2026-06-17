<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { DockviewVue } from 'dockview-vue'
import type { DockviewApi, DockviewReadyEvent, IDockviewPanel } from 'dockview-core'
import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon } from '@heroicons/vue/20/solid'
import ServersColumn from './columns/ServersColumn.vue'
import ProjectColumn from './columns/ProjectColumn.vue'
import ToolsColumn from './columns/ToolsColumn.vue'
import EditorPanel from './panels/EditorPanel.vue'
import TerminalPanel from './panels/TerminalPanel.vue'
import EditorTab from './panels/EditorTab.vue'
import StatusTray from './StatusTray.vue'
import IconButton from './ui/IconButton.vue'
import { useFilesStore, type OpenFile } from '@/stores/files'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { dock, type OpenTerminalOptions } from '@/services/dock'
import { setActiveTerminal } from '@/services/terminals'
import { registerCommands } from '@/services/commands'
import { viewsFor } from '@/services/views'

const files = useFilesStore()
const session = useSessionStore()
const agents = useAgentsStore()

const toolTabs = computed(() => viewsFor('sidebar.tools'))

// --- Hover flyouts for the collapsed sidebars ---
const serversHover = ref(false)
const toolsHover = ref(false)
let serversHideTimer: ReturnType<typeof setTimeout> | null = null
let toolsHideTimer: ReturnType<typeof setTimeout> | null = null

function onServersEnter() {
  if (serversHideTimer) { clearTimeout(serversHideTimer); serversHideTimer = null }
  serversHover.value = true
}
function onServersLeave() {
  serversHideTimer = setTimeout(() => { serversHover.value = false }, 100)
}
function onToolsEnter() {
  if (toolsHideTimer) { clearTimeout(toolsHideTimer); toolsHideTimer = null }
  toolsHover.value = true
}
function onToolsLeave() {
  toolsHideTimer = setTimeout(() => { toolsHover.value = false }, 100)
}

// --- Column layout (IDEA-style frame around the editor) ---
const FRAME_KEY = 'rebase.frame.v1'
const widths = reactive({ servers: 190, project: 230, tools: 340 })
const serversOpen = ref(true)
const toolsOpen = ref(false)

function loadFrame() {
  try {
    const f = JSON.parse(localStorage.getItem(FRAME_KEY) || '{}')
    if (f.widths) Object.assign(widths, f.widths)
    if (typeof f.serversOpen === 'boolean') serversOpen.value = f.serversOpen
    if (typeof f.toolsOpen === 'boolean') toolsOpen.value = f.toolsOpen
  } catch {
    /* ignore */
  }
}
loadFrame()
watch([widths, serversOpen, toolsOpen], () => {
  localStorage.setItem(
    FRAME_KEY,
    JSON.stringify({ widths, serversOpen: serversOpen.value, toolsOpen: toolsOpen.value }),
  )
})

function startDrag(target: 'servers' | 'project' | 'tools', e: MouseEvent) {
  const startX = e.clientX
  const startW = widths[target]
  const sign = target === 'tools' ? -1 : 1
  const move = (ev: MouseEvent) => {
    widths[target] = Math.min(560, Math.max(120, startW + sign * (ev.clientX - startX)))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// --- Dockview editor center ---
const components = {
  editor: markRaw(EditorPanel),
  terminal: markRaw(TerminalPanel),
}
// Custom tab with a useful right-click menu (close/close others/close all, copy path).
const tabComponents = {
  editorTab: markRaw(EditorTab),
}
const LAYOUT_KEY = 'rebase.editor.v2'
const dockApi = shallowRef<DockviewApi | null>(null)
const editorIds = new Set<string>()
let editorGroupId: string | null = null
let terminalSeq = 0
const editorEmpty = ref(true)

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || p
}

function addEditorPanel(api: DockviewApi, f: OpenFile) {
  if (api.getPanel(f.path)) return
  const within = editorGroupId && api.getGroup(editorGroupId)
  const panel = api.addPanel({
    id: f.path,
    component: 'editor',
    title: basename(f.path),
    params: { path: f.path, clientId: f.clientId },
    position: within ? { referenceGroup: editorGroupId as string, direction: 'within' } : undefined,
  })
  editorIds.add(f.path)
  editorGroupId = panel.group?.id ?? editorGroupId
  editorEmpty.value = false
}

// Open a terminal on demand — a fresh workspace has none. The terminal is bound
// to a server (the active agent unless an opener passes one) and to an optional
// initial cwd, both carried in panel params so the session survives a server
// switch.
function openTerminal(opts?: OpenTerminalOptions) {
  const api = dockApi.value
  if (!api) return
  const clientId = opts?.clientId ?? session.activeClientId
  if (!clientId) return
  const seq = ++terminalSeq
  api.addPanel({
    id: `terminal-${seq}`,
    component: 'terminal',
    title: `Terminal ${seq}`,
    params: { clientId, seq, initialCwd: opts?.initialCwd },
    position:
      editorGroupId && api.getGroup(editorGroupId)
        ? { referenceGroup: editorGroupId as string, direction: 'below' }
        : undefined,
  })
}

function onReady(event: DockviewReadyEvent) {
  const api = event.api
  dockApi.value = api

  const saved = localStorage.getItem(LAYOUT_KEY)
  if (saved) {
    try {
      api.fromJSON(JSON.parse(saved))
    } catch {
      api.clear()
    }
  }
  // A fresh workspace starts empty (the watermark overlay prompts the user) —
  // no blank editor tab and no terminal. Adopt whatever a saved layout restored.
  for (const p of api.panels) {
    if (p.id === 'terminal' || p.id.startsWith('terminal-')) {
      const n = Number(p.id.split('-')[1] ?? 0)
      if (n > terminalSeq) terminalSeq = n
    } else {
      editorIds.add(p.id)
      editorGroupId = p.group?.id ?? editorGroupId
    }
  }
  editorEmpty.value = api.panels.length === 0

  api.onDidRemovePanel((panel: IDockviewPanel) => {
    if (editorIds.delete(panel.id)) files.closeFile(panel.id)
  })
  api.onDidActivePanelChange((panel) => {
    if (panel && editorIds.has(panel.id)) files.activePath = panel.id
    setActiveTerminal(panel && panel.id.startsWith('terminal-') ? panel.id : null)
  })
  api.onDidLayoutChange(() => {
    editorEmpty.value = api.panels.length === 0
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()))
    } catch {
      /* ignore */
    }
  })

  dock.openTerminal = openTerminal
  dock.focusTerminal = (panelId) => api.getPanel(panelId)?.api.setActive()
  dock.closeTerminal = (panelId) => api.getPanel(panelId)?.api.close()
}

watch(
  () => files.openFiles.map((f) => f.path).join('\n'),
  () => {
    const api = dockApi.value
    if (!api) return
    for (const f of files.openFiles) addEditorPanel(api, f)
  },
)
watch(
  () => files.activePath,
  (path) => {
    if (path) dockApi.value?.getPanel(path)?.api.setActive()
  },
)
watch(
  () => session.activeClientId,
  () => {
    const api = dockApi.value
    if (!api) return
    for (const id of [...editorIds]) {
      const panel = api.getPanel(id)
      if (panel) api.removePanel(panel)
    }
  },
)

// --- Command contributions (state lives here, so the commands do too) ---
function closeActiveEditor() {
  const api = dockApi.value
  if (!api || !files.activePath) return
  const panel = api.getPanel(files.activePath)
  if (panel) api.removePanel(panel)
}
function closeAllEditors() {
  const api = dockApi.value
  if (!api) return
  for (const id of [...editorIds]) {
    const panel = api.getPanel(id)
    if (panel) api.removePanel(panel)
  }
}

let disposeWorkbenchCommands: (() => void) | undefined
onMounted(() => {
  disposeWorkbenchCommands = registerCommands([
    { id: 'view.toggleServers', title: 'Toggle Servers Sidebar', category: 'View', run: () => { serversOpen.value = !serversOpen.value } },
    { id: 'view.toggleTools', title: 'Toggle Tools Sidebar', category: 'View', run: () => { toolsOpen.value = !toolsOpen.value } },
    { id: 'editor.closeActive', title: 'Close Editor', category: 'Editor', isEnabled: () => !!files.activePath, run: closeActiveEditor },
    { id: 'editor.closeAll', title: 'Close All Editors', category: 'Editor', isEnabled: () => editorIds.size > 0, run: closeAllEditors },
  ])
})
onBeforeUnmount(() => disposeWorkbenchCommands?.())
</script>

<template>
  <div class="flex h-dvh flex-col">
    <div class="flex min-h-0 flex-1">
      <!-- Servers (collapsible) -->
      <template v-if="serversOpen">
        <aside class="flex min-h-0 shrink-0 flex-col bg-surface" :style="{ width: `${widths.servers}px` }">
          <div class="flex items-center justify-between border-b border-line py-1 pl-3 pr-2 text-xs uppercase tracking-[0.1em] text-subtle">
            <span>servers</span>
            <IconButton :icon="ChevronDoubleLeftIcon" variant="plain" label="collapse" @click="serversOpen = false" />
          </div>
          <ServersColumn />
        </aside>
        <div class="w-[3px] shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent" @mousedown.prevent="startDrag('servers', $event)" />
      </template>
      <!-- Collapsed servers: status dots + hover flyout -->
      <div
        v-else
        class="relative flex w-8 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-surface py-1.5"
        @mouseenter="onServersEnter"
        @mouseleave="onServersLeave"
      >
        <button
          v-for="agent in agents.sortedAgents"
          :key="agent.clientId"
          class="flex size-[26px] items-center justify-center rounded transition-colors hover:bg-hover"
          :class="agent.clientId === session.activeClientId ? 'bg-active' : ''"
          :title="agent.hostname || agent.clientId"
          @click="session.selectAgent(agent.clientId === session.activeClientId ? null : agent.clientId)"
        >
          <span class="size-[7px] rounded-full" :class="agent.authenticated ? 'bg-green' : 'bg-subtle'" />
        </button>
        <div v-if="agents.sortedAgents.length === 0" class="size-[7px] rounded-full bg-subtle/30" />
        <button
          class="mt-auto flex size-[26px] items-center justify-center text-subtle hover:text-fg"
          title="expand servers"
          @click="serversOpen = true"
        >
          <ChevronDoubleRightIcon class="size-3" />
        </button>
        <!-- Flyout: full ServersColumn on hover -->
        <div
          v-show="serversHover"
          class="absolute left-full top-0 z-50 w-56 max-h-[80vh] overflow-y-auto border-y border-r border-line bg-surface shadow-xl"
          @mouseenter="onServersEnter"
          @mouseleave="onServersLeave"
        >
          <ServersColumn />
        </div>
      </div>

      <!-- Project -->
      <aside class="flex min-h-0 shrink-0 flex-col bg-surface" :style="{ width: `${widths.project}px` }">
        <ProjectColumn />
      </aside>
      <div class="w-[3px] shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent" @mousedown.prevent="startDrag('project', $event)" />

      <!-- Editor (Dockview) -->
      <main class="relative min-h-0 min-w-0 flex-1">
        <DockviewVue
          class="dockview-theme-abyss h-full"
          :components="(components as any)"
          :tab-components="(tabComponents as any)"
          default-tab-component="editorTab"
          @ready="onReady"
        />
        <div
          v-if="editorEmpty"
          class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-subtle"
        >
          <p class="text-lg tracking-[0.08em]">rebase</p>
          <p class="text-sm">select a file to start editing</p>
        </div>
      </main>

      <!-- Tools (collapsible) -->
      <template v-if="toolsOpen">
        <div class="w-[3px] shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent" @mousedown.prevent="startDrag('tools', $event)" />
        <aside class="flex min-h-0 shrink-0 flex-col bg-surface" :style="{ width: `${widths.tools}px` }">
          <div class="flex items-center gap-2 border-b border-line py-1 pl-2 pr-3 text-xs uppercase tracking-[0.1em] text-subtle">
            <IconButton :icon="ChevronDoubleRightIcon" variant="plain" label="collapse" @click="toolsOpen = false" />
            <span>tools</span>
          </div>
          <ToolsColumn />
        </aside>
      </template>
      <!-- Collapsed tools: plugin icons + hover flyout -->
      <div
        v-else
        class="relative flex w-8 shrink-0 flex-col items-center gap-1 border-l border-line bg-surface py-1.5"
        @mouseenter="onToolsEnter"
        @mouseleave="onToolsLeave"
      >
        <button
          v-for="tab in toolTabs"
          :key="tab.id"
          class="flex size-8 items-center justify-center rounded text-subtle transition-colors hover:bg-hover hover:text-fg"
          :title="tab.title"
          @click="toolsOpen = true"
        >
          <component :is="tab.icon" class="size-5" />
        </button>
        <button
          class="mt-auto flex size-[26px] items-center justify-center text-subtle hover:text-fg"
          title="expand tools"
          @click="toolsOpen = true"
        >
          <ChevronDoubleLeftIcon class="size-3" />
        </button>
        <!-- Flyout: full ToolsColumn on hover -->
        <div
          v-show="toolsHover"
          class="absolute right-full top-0 z-50 w-80 max-h-[80vh] overflow-y-auto border-y border-l border-line bg-surface shadow-xl"
          @mouseenter="onToolsEnter"
          @mouseleave="onToolsLeave"
        >
          <ToolsColumn />
        </div>
      </div>
    </div>
    <StatusTray />
  </div>
</template>
