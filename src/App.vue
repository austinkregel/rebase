<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import ConnectionGate from '@/components/ConnectionGate.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import NotificationToasts from '@/components/NotificationToasts.vue'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { useProjectsStore } from '@/stores/projects'
import { useFilesStore } from '@/stores/files'
import { registerCommands } from '@/services/commands'
import { handleKeydown } from '@/services/keybindings'
import { activatePlugins, deactivatePlugins } from '@/services/plugins'
import { dock } from '@/services/dock'
import { checkForUpdate } from '@/services/updater'
import { bundledPlugins } from '@/plugins'

const session = useSessionStore()
const agents = useAgentsStore()
const settings = useSettingsStore()
const projects = useProjectsStore()
const files = useFilesStore()

let disposeCommands: (() => void) | undefined
let stopReopenWatch: (() => void) | undefined

onMounted(() => {
  agents.listen()
  void agents.hydrate()
  void settings.load()
  void projects.load()
  void files.loadExpanded()
  void session.start()
  // Fire-and-forget: the update prompt must never gate the workbench appearing,
  // and checkForUpdate resolves rather than throws on every failure path.
  void checkForUpdate()

  // Core, store-only commands. View/editor/terminal commands are contributed by
  // the workbench (where their state lives).
  disposeCommands = registerCommands([
    {
      id: 'file.saveActive',
      title: 'Save File',
      category: 'File',
      isEnabled: () => !!files.activeFile,
      run: () => {
        if (files.activePath) void files.saveFile(files.activePath)
      },
    },
    {
      id: 'file.saveAll',
      title: 'Save All',
      category: 'File',
      isEnabled: () => files.dirtyCount > 0,
      run: () => {
        for (const f of files.openFiles) {
          if (f.content !== f.savedContent) void files.saveFile(f.path)
        }
      },
    },
    {
      id: 'server.disconnect',
      title: 'Disconnect from Control Plane',
      category: 'Server',
      isEnabled: () => session.socketStatus === 'open',
      run: () => session.disconnect(),
    },
  ])

  // Reopen the project that was active before the last refresh, but only once its
  // server reappears in the control plane's client list (the socket must be up and
  // the agent online). This rehydrates the saved directory tree for that server.
  let reopened = false
  const stopReopen = watch(
    () => [session.socketStatus, agents.agents.length] as const,
    () => {
      if (reopened || !projects.loaded || session.socketStatus !== 'open') return
      const id = projects.activeId
      if (!id) return
      const project = projects.projects.find((p) => p.id === id)
      if (!project || !agents.byId(project.clientId)) return
      reopened = true
      stopReopen()
      projects.open(id)
    },
    { immediate: true },
  )
  stopReopenWatch = stopReopen

  window.addEventListener('keydown', handleKeydown)

  // Activate bundled plugins. The terminal capability is resolved lazily through
  // the dock service (the Workbench wires dock.openTerminal once it mounts).
  void activatePlugins(bundledPlugins, { openTerminal: (opts) => dock.openTerminal?.(opts) })
})

onBeforeUnmount(() => {
  disposeCommands?.()
  stopReopenWatch?.()
  deactivatePlugins()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <ConnectionGate />
  <!-- App-wide singletons (one instance, driven by their reactive services). -->
  <ContextMenu />
  <ConfirmDialog />
  <CommandPalette />
  <NotificationToasts />
</template>
