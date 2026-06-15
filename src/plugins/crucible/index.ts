import { markRaw, watch } from 'vue'
import { SparklesIcon as SparklesOutline } from '@heroicons/vue/24/outline'
import { SparklesIcon } from '@heroicons/vue/20/solid'
import { definePlugin } from '@/services/plugins'
import { runCommand } from '@/services/commands'
import { notify } from '@/services/notifications'
import type { FileMenuContext, ProjectMenuContext } from '@/services/menus'
import { normalizeRoot } from '@/services/paths'
import { useProjectsStore, type Project } from '@/stores/projects'
import { rebuild, maybeAutoRefresh } from '@/services/crucible'
import { addPin } from '@/services/crucibleState'
import CrucibleChat from './CrucibleChat.vue'
import CrucibleStatus from './CrucibleStatus.vue'

// Crucible: the codebase-chat feature. Contributes the chat view (Tools column),
// the index status + refresh button (status bar), index commands/keybindings, and
// "Index with Crucible" / "Add to Crucible chat" context-menu items. The index
// lifecycle + chat live in services/crucible*.ts; this file is just the surfaces.

/** The project (on `clientId`) that owns `path` as one of its roots, if any. */
function projectForFolder(clientId: string, path: string): Project | undefined {
  const root = normalizeRoot(path)
  return useProjectsStore().projects.find(
    (p) => p.clientId === clientId && p.rootPaths.map(normalizeRoot).includes(root),
  )
}

let stopWatch: (() => void) | undefined

export default definePlugin({
  id: 'core.crucible',
  name: 'Crucible',
  activate(ctx) {
    ctx.registerView({
      id: 'crucible',
      location: 'sidebar.tools',
      title: 'Crucible',
      icon: SparklesOutline,
      iconActive: SparklesIcon,
      order: 1,
      component: markRaw(CrucibleChat),
    })

    ctx.registerStatusItem({
      id: 'crucible.status',
      side: 'right',
      order: 5,
      component: markRaw(CrucibleStatus),
    })

    ctx.registerCommands([
      {
        id: 'crucible.openChat',
        title: 'Toggle Crucible Chat',
        category: 'Crucible',
        run: () => void runCommand('view.toggleTools'),
      },
      {
        id: 'crucible.rebuild',
        title: 'Rebuild Index',
        category: 'Crucible',
        isEnabled: () => !!useProjectsStore().active,
        run: () => {
          const active = useProjectsStore().active
          if (active) void rebuild(active)
          else notify.warning('Open a project to index', { source: 'Crucible' })
        },
      },
    ])

    ctx.registerKeybinding({ mod: true, key: 'l', command: 'crucible.openChat' })
    ctx.registerKeybinding({ mod: true, shift: true, key: 'i', command: 'crucible.rebuild' })

    // "Index with Crucible" on a project, or on a folder that is a project root.
    ctx.registerMenuItem<ProjectMenuContext>({
      id: 'crucible.indexProject',
      menu: 'project/context',
      order: 30,
      build: (c) => ({
        label: 'Index with Crucible',
        action: () => {
          const project = useProjectsStore().projects.find((p) => p.id === c.projectId)
          if (project) void rebuild(project)
        },
      }),
    })
    ctx.registerMenuItem<FileMenuContext>({
      id: 'crucible.indexFolder',
      menu: 'folder/context',
      order: 55,
      when: (c) => !!projectForFolder(c.clientId, c.path),
      build: (c) => ({
        label: 'Index with Crucible',
        action: () => {
          const project = projectForFolder(c.clientId, c.path)
          if (project) void rebuild(project)
        },
      }),
    })

    // "Add to Crucible chat" pins a file as explicit context for the next turn.
    ctx.registerMenuItem<FileMenuContext>({
      id: 'crucible.pinFile',
      menu: 'file/context',
      order: 60,
      when: () => !!useProjectsStore().active,
      build: (c) => ({
        label: 'Add to Crucible chat',
        action: () => {
          const active = useProjectsStore().active
          if (active) addPin(active.id, { path: c.path, clientId: c.clientId })
        },
      }),
    })

    // Incremental refresh when a project is opened (only if it's already indexed).
    stopWatch = watch(
      () => useProjectsStore().activeId,
      (id) => {
        if (!id) return
        const active = useProjectsStore().active
        if (active) void maybeAutoRefresh(active)
      },
      { immediate: true },
    )
  },

  deactivate() {
    stopWatch?.()
    stopWatch = undefined
  },
})
