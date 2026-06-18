import { markRaw } from 'vue'
import { BeakerIcon } from '@heroicons/vue/20/solid'
import { definePlugin } from '@/services/plugins'
import type { FileMenuContext } from '@/services/menus'
import { notify } from '@/services/notifications'
import { counter, clockTime, eventLog, logEvent } from './state'
import DemoStatus from './DemoStatus.vue'
import DemoPanel from './DemoPanel.vue'

// Module-scoped cleanup handle — cleared in deactivate().
let clockInterval: ReturnType<typeof setInterval> | null = null

export default definePlugin({
  id: 'demo',
  name: 'Demo Plugin',

  activate(ctx) {
    // Start the live clock that DemoStatus.vue reads from.
    clockTime.value = new Date().toLocaleTimeString()
    clockInterval = setInterval(() => {
      clockTime.value = new Date().toLocaleTimeString()
    }, 1000)

    logEvent('plugin activated')

    // ── Status bar: simple text item (left side) ──────────────────────────
    // Exercises: text(), command, tooltip, side, order.
    // Clicking the label runs a command.
    ctx.registerStatusItem({
      id: 'demo.counter',
      side: 'left',
      order: 100,
      text: () => `demo ×${counter.value}`,
      tooltip: 'Demo counter — click to increment',
      command: 'demo.increment',
    })

    // ── Status bar: custom component (right side) ─────────────────────────
    // Exercises: component (full rendering control, uses IconButton from
    // the design system, reads reactive state from ./state.ts).
    ctx.registerStatusItem({
      id: 'demo.clock',
      side: 'right',
      order: 5,
      component: markRaw(DemoStatus),
    })

    // ── Commands ──────────────────────────────────────────────────────────
    ctx.registerCommand({
      id: 'demo.increment',
      title: 'Increment Demo Counter',
      category: 'Demo',
      run() {
        counter.value++
        logEvent(`incremented → ${counter.value}`)
        if (counter.value % 5 === 0) {
          notify.info(`Demo counter hit ${counter.value}`, { source: 'Demo Plugin' })
        }
      },
    })

    ctx.registerCommand({
      id: 'demo.reset',
      title: 'Reset Demo Counter',
      category: 'Demo',
      run() {
        logEvent(`reset from ${counter.value}`)
        counter.value = 0
      },
    })

    // Exercises: command that fires a notification (cross-plugin API usage).
    ctx.registerCommand({
      id: 'demo.ping',
      title: 'Demo: Send a Notification',
      category: 'Demo',
      run() {
        notify.info('Ping from Demo Plugin', {
          source: 'Demo Plugin',
          body: 'Commands, notifications, and status items are all wired up.',
        })
        logEvent('pinged notification service')
      },
    })

    // ── Keybinding ────────────────────────────────────────────────────────
    ctx.registerKeybinding({
      mod: true,
      shift: true,
      key: 'd',
      command: 'demo.ping',
    })

    // ── Sidebar view ──────────────────────────────────────────────────────
    // Exercises: registerView with location, icon, order, component.
    ctx.registerView({
      id: 'demo.panel',
      location: 'sidebar.tools',
      title: 'Demo',
      icon: BeakerIcon,
      order: 99,
      component: markRaw(DemoPanel),
    })

    // ── Context menu items ────────────────────────────────────────────────
    // Exercises: registerMenuItem with build(), FileMenuContext typing,
    // and two different menu IDs for the same logical action.
    ctx.registerMenuItem<FileMenuContext>({
      id: 'demo.logFilePath',
      menu: 'file/context',
      build(fileCtx) {
        return {
          label: 'Demo: Log File Path',
          action() {
            logEvent(`file: ${fileCtx.path}`)
            counter.value++
          },
        }
      },
    })

    ctx.registerMenuItem<FileMenuContext>({
      id: 'demo.logFolderPath',
      menu: 'folder/context',
      build(fileCtx) {
        return {
          label: 'Demo: Log Folder Path',
          action() {
            logEvent(`folder: ${fileCtx.path}`)
            counter.value++
          },
        }
      },
    })
  },

  deactivate() {
    if (clockInterval !== null) {
      clearInterval(clockInterval)
      clockInterval = null
    }
    counter.value = 0
    eventLog.value = []
  },
})
