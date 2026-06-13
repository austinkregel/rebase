<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import ConnectionGate from '@/components/ConnectionGate.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import { useSettingsStore } from '@/stores/settings'
import { useProjectsStore } from '@/stores/projects'
import { useFilesStore } from '@/stores/files'
import { registerCommands } from '@/services/commands'
import { handleKeydown } from '@/services/keybindings'

const session = useSessionStore()
const agents = useAgentsStore()
const settings = useSettingsStore()
const projects = useProjectsStore()
const files = useFilesStore()

let disposeCommands: (() => void) | undefined

onMounted(() => {
  agents.listen()
  void settings.load()
  void projects.load()
  void session.start()

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

  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  disposeCommands?.()
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <ConnectionGate />
  <!-- App-wide singletons (one instance, driven by their reactive services). -->
  <ContextMenu />
  <ConfirmDialog />
  <CommandPalette />
</template>
