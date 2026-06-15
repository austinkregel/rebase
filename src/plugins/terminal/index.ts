import { markRaw } from 'vue'
import { CommandLineIcon } from '@heroicons/vue/20/solid'
import { CommandLineIcon as CommandLineOutline } from '@heroicons/vue/24/outline'
import { definePlugin } from '@/services/plugins'
import { dock } from '@/services/dock'
import { terminalEntries } from '@/services/terminals'
import type { FileMenuContext, ProjectRootMenuContext } from '@/services/menus'
import TerminalsView from '@/components/panels/TerminalsView.vue'

// Terminal entry points: the new/focus/kill commands + keybindings, the status
// bar button, the Tools-column "Terminals" list, and "Open in Terminal" on
// folder/project-root menus. The dockview terminal *panels* stay host-owned —
// the plugin drives them through the dock capability/service.
export default definePlugin({
  id: 'core.terminal',
  name: 'Terminal',
  activate(ctx) {
    ctx.registerCommands([
      { id: 'terminal.new', title: 'New Terminal', category: 'Terminal', run: () => ctx.host.openTerminal() },
      {
        id: 'terminal.focus',
        title: 'Focus Terminal',
        category: 'Terminal',
        run: () => {
          const list = terminalEntries()
          const last = list[list.length - 1]
          if (last) dock.focusTerminal?.(last.panelId)
          else ctx.host.openTerminal()
        },
      },
      {
        id: 'terminal.killAll',
        title: 'Kill All Terminals',
        category: 'Terminal',
        isEnabled: () => terminalEntries().length > 0,
        run: () => {
          for (const e of [...terminalEntries()]) dock.closeTerminal?.(e.panelId)
        },
      },
    ])

    ctx.registerKeybinding({ ctrl: true, key: '`', command: 'terminal.new' })
    ctx.registerKeybinding({ mod: true, shift: true, key: '`', command: 'terminal.focus' })

    ctx.registerStatusItem({
      id: 'terminal.new',
      side: 'right',
      order: 10,
      icon: CommandLineIcon,
      tooltip: 'new terminal',
      command: 'terminal.new',
    })

    ctx.registerView({
      id: 'terminal.list',
      location: 'sidebar.tools',
      title: 'Terminals',
      icon: CommandLineOutline,
      iconActive: CommandLineIcon,
      order: 5,
      component: markRaw(TerminalsView),
    })

    // "Open in Terminal" → a terminal bound to that server, cd'd into the path
    // (client-side; the PTY protocol has no cwd).
    ctx.registerMenuItem<FileMenuContext>({
      id: 'terminal.openInFolder',
      menu: 'folder/context',
      order: 40,
      build: (c) => ({
        label: 'Open in Terminal',
        action: () => dock.openTerminal?.({ clientId: c.clientId, initialCwd: c.path }),
      }),
    })
    ctx.registerMenuItem<ProjectRootMenuContext>({
      id: 'terminal.openInProjectRoot',
      menu: 'projectRoot/context',
      order: 40,
      build: (c) => ({
        label: 'Open in Terminal',
        action: () => dock.openTerminal?.({ clientId: c.clientId, initialCwd: c.root }),
      }),
    })
  },
})
