<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { DockviewVue } from 'dockview-vue'
import type { DockviewApi, DockviewReadyEvent, IDockviewPanel } from 'dockview-core'
import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon } from '@heroicons/vue/20/solid'
import { CommandLineIcon, ServerIcon } from '@heroicons/vue/24/outline'
import ServersColumn from './columns/ServersColumn.vue'
import ProjectColumn from './columns/ProjectColumn.vue'
import ToolsColumn from './columns/ToolsColumn.vue'
import EditorPanel from './panels/EditorPanel.vue'
import TerminalPanel from './panels/TerminalPanel.vue'
import EditorTab from './panels/EditorTab.vue'
import StatusTray from './StatusTray.vue'
import IconButton from './ui/IconButton.vue'
import { useFilesStore, fileKey, parseFileKey, type OpenFile } from '@/stores/files'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { useProjectsStore } from '@/stores/projects'
import { dock, type OpenTerminalOptions } from '@/services/dock'
import { loadValue, loadValueMigrating, saveValue } from '@/services/store'
import { setActiveTerminal } from '@/services/terminals'
import { registerCommands } from '@/services/commands'
import { viewsFor } from '@/services/views'

const files = useFilesStore()
const session = useSessionStore()
const agents = useAgentsStore()
const projects = useProjectsStore()

const toolTabs = computed(() => viewsFor('sidebar.tools'))

// Collapsed servers rail: in project mode, dim every server that isn't the
// focused project's — visible and still clickable, clearly not what you're on.
function railDim(clientId: string): boolean {
  return projects.inProjectMode && clientId !== projects.focused?.clientId
}

// --- Hover flyouts for the collapsed sidebars ---
const toolsHover = ref(false)
let toolsHideTimer: ReturnType<typeof setTimeout> | null = null
function onToolsEnter() {
  if (toolsHideTimer) { clearTimeout(toolsHideTimer); toolsHideTimer = null }
  toolsHover.value = true
}
function onToolsLeave() {
  toolsHideTimer = setTimeout(() => { toolsHover.value = false }, 100)
}

// --- Column layout (IDEA-style frame around the editor) ---
// Both keys go through services/store.ts. In the browser they resolve to the
// same localStorage keys as before ('rebase.' + key); on desktop they move into
// rebase.json, and loadValueMigrating adopts the webview's old copy once.
const FRAME_KEY = 'frame.v1'
const FRAME_LEGACY_KEY = 'rebase.frame.v1'
const widths = reactive({ servers: 190, project: 230, tools: 340 })
const serversOpen = ref(true)
const toolsOpen = ref(false)

interface FrameState {
  widths?: Partial<typeof widths>
  serversOpen?: boolean
  toolsOpen?: boolean
}

// Persistence is async now, so the defaults are on screen for a tick before the
// saved frame lands. Don't write until it has, or that tick overwrites it.
const frameHydrated = ref(false)

async function loadFrame() {
  const f = await loadValueMigrating<FrameState>(FRAME_KEY, FRAME_LEGACY_KEY, {})
  if (f.widths) Object.assign(widths, f.widths)
  if (typeof f.serversOpen === 'boolean') serversOpen.value = f.serversOpen
  if (typeof f.toolsOpen === 'boolean') toolsOpen.value = f.toolsOpen
  frameHydrated.value = true
}

watch([widths, serversOpen, toolsOpen], () => {
  if (!frameHydrated.value) return
  void saveValue<FrameState>(FRAME_KEY, {
    widths: { ...widths },
    serversOpen: serversOpen.value,
    toolsOpen: toolsOpen.value,
  })
})

// Project mode collapses the servers column to its rail; leaving restores it to
// whatever it was. Save-and-restore, not a hard true on exit: someone who works
// with it collapsed all day shouldn't have it thrown open for leaving a project.
// Only the mode transition touches it, so expanding by hand mid-mode stays sticky.
let serversOpenBeforeFocus: boolean | null = null
watch(
  () => projects.inProjectMode,
  (on) => {
    if (on) {
      serversOpenBeforeFocus = serversOpen.value
      serversOpen.value = false
    } else if (serversOpenBeforeFocus !== null) {
      serversOpen.value = serversOpenBeforeFocus
      serversOpenBeforeFocus = null
    }
  },
  { immediate: true },
)

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
// v3: panel ids are now the composite fileKey(clientId, path), not the raw path,
// so open files are identified per-server. Older layouts (editor.v2*) hold
// path-only ids that would no longer reconcile, so they are intentionally not
// migrated — the editor layout resets once and reopens from panel params.
const LAYOUT_KEY = 'editor.v3'

/** Persistence key for the current editor layout. In project mode each project
 *  keeps its own (`editor.v3:<id>`) so switching projects restores that
 *  project's tabs instead of the shared fleet set. */
function layoutKey(id: string | null = projects.focusedId): string {
  return id ? `${LAYOUT_KEY}:${id}` : LAYOUT_KEY
}
function loadLayoutFor(id: string | null): Promise<object | null> {
  return loadValue<object | null>(layoutKey(id), null)
}

const dockApi = shallowRef<DockviewApi | null>(null)
const editorIds = new Set<string>()
let editorGroupId: string | null = null
/** True while fromJSON rebuilds the layout — suppresses the save handler. */
let hydratingLayout = false
let terminalSeq = 0
const editorEmpty = ref(true)

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || p
}

function addEditorPanel(api: DockviewApi, f: OpenFile) {
  const id = fileKey(f.clientId, f.path)
  if (api.getPanel(id)) return
  const within = editorGroupId && api.getGroup(editorGroupId)
  const panel = api.addPanel({
    id,
    component: 'editor',
    title: basename(f.path),
    params: { path: f.path, clientId: f.clientId },
    position: within ? { referenceGroup: editorGroupId as string, direction: 'within' } : undefined,
  })
  editorIds.add(id)
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
  // In project mode, a terminal on the project's own server opens at its primary
  // root and is titled with the project. Guarded on clientId so a terminal opened
  // against another host isn't cd'd into a path that doesn't exist there.
  const inProject = projects.inProjectMode && clientId === projects.focused?.clientId
  const initialCwd = opts?.initialCwd ?? (inProject ? projects.primaryRoot ?? undefined : undefined)
  const seq = ++terminalSeq
  api.addPanel({
    id: `terminal-${seq}`,
    component: 'terminal',
    title: inProject ? `Terminal ${seq} · ${projects.focused?.name}` : `Terminal ${seq}`,
    params: { clientId, seq, initialCwd },
    position:
      editorGroupId && api.getGroup(editorGroupId)
        ? { referenceGroup: editorGroupId as string, direction: 'below' }
        : undefined,
  })
}

async function onReady(event: DockviewReadyEvent) {
  const api = event.api
  dockApi.value = api

  // fromJSON fires onDidLayoutChange as it rebuilds; with an async read the
  // handler is already live, so guard the write or a half-built layout is what
  // gets saved.
  const saved = await loadLayoutFor(projects.focusedId)
  if (saved) {
    hydratingLayout = true
    try {
      api.fromJSON(saved as Parameters<typeof api.fromJSON>[0])
    } catch {
      api.clear()
    } finally {
      hydratingLayout = false
    }
  }
  // A fresh workspace starts empty (the watermark overlay prompts the user) —
  // no blank editor tab and no terminal. Adopt whatever a saved layout restored.
  for (const p of api.panels) {
    if (p.id === 'terminal' || p.id.startsWith('terminal-')) {
      // Legacy bare `terminal` (no seq) counts as 0; `terminal-<n>` parses to n.
      const n = p.id === 'terminal' ? 0 : Number(p.id.split('-')[1])
      if (Number.isFinite(n) && n > terminalSeq) terminalSeq = n
    } else {
      editorIds.add(p.id)
      editorGroupId = p.group?.id ?? editorGroupId
    }
  }
  editorEmpty.value = api.panels.length === 0

  api.onDidRemovePanel((panel: IDockviewPanel) => {
    if (editorIds.delete(panel.id)) {
      const { clientId, path } = parseFileKey(panel.id)
      files.closeFile(clientId, path)
    }
  })
  api.onDidActivePanelChange((panel) => {
    if (panel && editorIds.has(panel.id)) files.activeKey = panel.id
    setActiveTerminal(panel && panel.id.startsWith('terminal-') ? panel.id : null)
  })
  api.onDidLayoutChange(() => {
    editorEmpty.value = api.panels.length === 0
    if (hydratingLayout) return
    void saveValue(layoutKey(), api.toJSON())
  })

  dock.openTerminal = openTerminal
  dock.focusTerminal = (panelId) => api.getPanel(panelId)?.api.setActive()
  dock.closeTerminal = (panelId) => api.getPanel(panelId)?.api.close()
}

watch(
  () => files.openFiles.map((f) => fileKey(f.clientId, f.path)).join('\n'),
  () => {
    const api = dockApi.value
    if (!api) return
    for (const f of files.openFiles) addEditorPanel(api, f)
  },
)
watch(
  () => files.activeKey,
  (key) => {
    if (key) dockApi.value?.getPanel(key)?.api.setActive()
  },
)
watch(
  () => session.activeClientId,
  () => {
    const api = dockApi.value
    if (!api) return
    // In project mode the per-project layout owns the tabs — don't wipe them
    // just because glancing at a neighbouring server changed the active agent.
    // The focusedId watcher below handles clearing/restoring on a real switch.
    if (projects.inProjectMode) return
    for (const id of [...editorIds]) {
      const panel = api.getPanel(id)
      if (panel) api.removePanel(panel)
    }
  },
)

// Per-project editor layout: entering, leaving, or switching the focused project
// persists the layout we're leaving under its own key, then clears and rehydrates
// the one we're entering. `editor.v2:<id>` (a project) and `editor.v2` (fleet)
// each keep their own tab set. Save-before-clear is why the activeClientId
// watcher above must not wipe first — in project mode it doesn't.
watch(
  () => projects.focusedId,
  async (newId, oldId) => {
    const api = dockApi.value
    if (!api) return
    if (!hydratingLayout) void saveValue(layoutKey(oldId), api.toJSON())
    hydratingLayout = true
    try {
      api.clear()
      editorIds.clear()
      editorGroupId = null
      const saved = await loadLayoutFor(newId)
      if (saved) {
        try {
          api.fromJSON(saved as Parameters<typeof api.fromJSON>[0])
        } catch {
          api.clear()
        }
      }
      for (const p of api.panels) {
        if (p.id.startsWith('terminal-')) {
          const n = Number(p.id.split('-')[1] ?? 0)
          if (n > terminalSeq) terminalSeq = n
        } else {
          editorIds.add(p.id)
          editorGroupId = p.group?.id ?? editorGroupId
        }
      }
    } finally {
      hydratingLayout = false
      editorEmpty.value = api.panels.length === 0
      void saveValue(layoutKey(newId), api.toJSON())
    }
  },
)

// --- Command contributions (state lives here, so the commands do too) ---
function closeActiveEditor() {
  const api = dockApi.value
  if (!api || !files.activeKey) return
  const panel = api.getPanel(files.activeKey)
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
  void loadFrame()
  disposeWorkbenchCommands = registerCommands([
    { id: 'view.toggleServers', title: 'Toggle Servers Sidebar', category: 'View', run: () => { serversOpen.value = !serversOpen.value } },
    { id: 'view.toggleTools', title: 'Toggle Tools Sidebar', category: 'View', run: () => { toolsOpen.value = !toolsOpen.value } },
    { id: 'editor.closeActive', title: 'Close Editor', category: 'Editor', isEnabled: () => !!files.activeKey, run: closeActiveEditor },
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
          <div class="flex items-center justify-between border-b border-line py-2.5 pl-3 pr-2 text-md uppercase tracking-widest text-subtle">
            <span class="flex items-center gap-2">
              <CommandLineIcon class="w-5 h-5 inline" />
              Rebase
            </span>
            <IconButton :icon="ChevronDoubleLeftIcon" variant="plain" label="collapse" @click="serversOpen = false" />
          </div>
          <ServersColumn />
        </aside>
        <div class="w-[3px] shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent" @mousedown.prevent="startDrag('servers', $event)" />
      </template>
      <!-- Collapsed servers: status dots at top, expand button pinned below -->
      <div
        v-else
        class="relative flex w-8 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-surface py-1.5"
      >
        <button
          class="flex size-[26px] items-center justify-center text-subtle hover:text-fg"
          title="expand servers"
          @click="serversOpen = true"
        >
          <ChevronDoubleRightIcon class="size-3" />
        </button>

        <div class="my-3.5">
          <ServerIcon class="w-4 h-4 text-subtle" />
        </div>
        <button
          v-for="agent in agents.sortedAgents"
          :key="agent.clientId"
          class="flex size-[26px] items-center justify-center rounded transition-colors hover:bg-hover"
          :class="[agent.clientId === session.activeClientId ? 'bg-active' : '', { 'opacity-40 hover:opacity-100': railDim(agent.clientId) }]"
          :title="agent.hostname || agent.clientId"
          @click="session.selectAgent(agent.clientId === session.activeClientId ? null : agent.clientId)"
        >
          <span class="size-[7px] rounded-full" :class="agent.authenticated ? 'bg-green' : 'bg-subtle'" />
        </button>
        <div v-if="agents.sortedAgents.length === 0" class="size-[7px] rounded-full bg-subtle/30" />
      </div>

      <!-- Project -->
      <aside class="flex min-h-0 shrink-0 flex-col" :style="{ width: `${widths.project}px` }">
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
