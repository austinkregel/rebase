/**
 * Plugin template — copy this directory to src/plugins/your-name/, replace all
 * occurrences of "your-plugin-id" and "Your Plugin Name", swap in real icon
 * imports, then add the plugin to src/plugins/index.ts.
 *
 * Every registration returns a disposer, but you don't need to call them: the
 * plugin host tracks and calls all of them automatically in deactivate().
 */
import { definePlugin } from '@/services/plugins'
import { markRaw } from 'vue'
import TemplateStatus from './TemplateStatus.vue'
import type { FileMenuContext } from '@/services/menus'
// Replace with real Heroicons (this generic one is just a placeholder):
import { PuzzlePieceIcon } from '@heroicons/vue/20/solid'

export default definePlugin({
  id: 'your-plugin-id',
  name: 'Your Plugin Name',

  activate(ctx) {
    // ── 1. Status bar — simple form ──────────────────────────────────────────
    // Use this when an icon or short text label + a command click is enough.
    ctx.registerStatusItem({
      id: 'your-plugin-id.status',
      side: 'right',         // 'left' | 'right'
      order: 50,             // lower = closer to the outer edge; right items sort ascending
      // icon: SomeIcon,     // FunctionalComponent from @heroicons/vue/20/solid
      text: () => 'Label',   // reactive: called every render
      tooltip: 'Click to open',
      command: 'your-plugin-id.openPanel',
      // when: () => someRef.value,   // hide/show reactively
    })

    // ── 2. Status bar — custom component ────────────────────────────────────
    // Use this when you need a popover, badge, animated icon, etc.
    // The component receives no props — use stores or service functions inside it.
    // See CrucibleStatus.vue / NotificationsStatus.vue for real examples.
    ctx.registerStatusItem({
      id: 'your-plugin-id.status-rich',
      side: 'right',
      order: 55,
      component: markRaw(TemplateStatus),
    })

    // ── 3. Command ───────────────────────────────────────────────────────────
    // Appears in the command palette. Wire it to a keybinding below.
    ctx.registerCommand({
      id: 'your-plugin-id.openPanel',
      title: 'Open My Panel',
      category: 'My Plugin',
      run() {
        // e.g. toggle a reactive ref that controls a sidebar view
      },
    })

    // ── 4. Keybinding ────────────────────────────────────────────────────────
    // mod = Cmd on macOS, Ctrl elsewhere. ctrl = literal Ctrl everywhere.
    ctx.registerKeybinding({
      mod: true,
      shift: true,
      key: 'p',
      command: 'your-plugin-id.openPanel',
    })

    // ── 5. Sidebar view ──────────────────────────────────────────────────────
    // Adds a tab to the tools column ('sidebar.tools') or the project column
    // ('sidebar.project'). Use outline/solid icon pair for the active indicator.
    ctx.registerView({
      id: 'your-plugin-id.panel',
      location: 'sidebar.tools',
      title: 'My Panel',
      // Swap these for your own outline/solid icon pair and panel component.
      icon: PuzzlePieceIcon,
      iconActive: PuzzlePieceIcon,
      order: 90,
      component: markRaw(TemplateStatus),
    })

    // ── 6. Context menu item ─────────────────────────────────────────────────
    // menu IDs: 'file/context' | 'folder/context' | 'project/context' |
    //           'projectRoot/context' | 'server/context' |
    //           'editorTab/context' | 'terminal/context'
    // ctx type is inferred from the menu ID (FileMenuContext, etc.)
    ctx.registerMenuItem<FileMenuContext>({
      id: 'your-plugin-id.contextAction',
      menu: 'file/context',
      build(fileCtx) {
        return [
          {
            label: 'My Action',
            action: () => {
              console.log(fileCtx.path)
            },
          },
        ]
      },
    })
  },

  deactivate() {
    // All registrations are cleaned up automatically via disposers.
    // Add explicit cleanup here only for timers, WebSocket connections,
    // or other external resources your activate() started.
  },
})
