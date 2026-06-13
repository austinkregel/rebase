import { CommandLineIcon } from '@heroicons/vue/20/solid'
import { definePlugin } from '@/services/plugins'

// The terminal entry points (command, status button, Ctrl+` keybinding). The
// dockview terminal *panel* stays host-owned; the plugin opens it via the host
// capability. Demonstrates command + status-item + keybinding contributions.
export default definePlugin({
  id: 'core.terminal',
  name: 'Terminal',
  activate(ctx) {
    ctx.registerCommand({
      id: 'terminal.new',
      title: 'New Terminal',
      category: 'Terminal',
      run: () => ctx.host.openTerminal(),
    })
    ctx.registerKeybinding({ ctrl: true, key: '`', command: 'terminal.new' })
    ctx.registerStatusItem({
      id: 'terminal.new',
      side: 'right',
      order: 10,
      icon: CommandLineIcon,
      tooltip: 'new terminal',
      command: 'terminal.new',
    })
  },
})
