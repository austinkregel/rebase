import { reactive } from 'vue'

/**
 * Bridge for triggering Dockview actions from outside the Workbench (e.g. the
 * status tray's "terminal" button). The Workbench registers the callbacks on
 * mount; consumers call them (no-op until registered).
 */
export const dock = reactive<{ openTerminal: (() => void) | null }>({
  openTerminal: null,
})
