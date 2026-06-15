import { markRaw, watch } from 'vue'
import { definePlugin } from '@/services/plugins'
import { useSessionStore } from '@/stores/session'
import { notify } from '@/services/notifications'
import NotificationsStatus from './NotificationsStatus.vue'

// Surfaces app notifications: the status-bar bell + center (NotificationsStatus)
// and the emitters that raise notifications for connection events. The toast
// overlay and notify() API are core (services/notifications.ts + App.vue), so
// they keep working even with this plugin disabled — only the bell + emitters go.
let stopConnectionWatch: (() => void) | undefined

export default definePlugin({
  id: 'core.notifications',
  name: 'Notifications',
  activate(ctx) {
    ctx.registerStatusItem({
      id: 'notifications.bell',
      side: 'right',
      order: 20,
      component: markRaw(NotificationsStatus),
    })

    // Connection up/down → notifications. Toast on a (re)connect into `open` and
    // when an established connection drops; the socket auto-reconnects, so a
    // drop is a warning (auto-dismiss) rather than a sticky error.
    const session = useSessionStore()
    stopConnectionWatch = watch(
      () => session.socketStatus,
      (status, prev) => {
        if (status === 'open' && prev && prev !== 'open') {
          notify.success('Connected', { source: 'Connection' })
        } else if (status === 'closed' && prev === 'open') {
          notify.warning('Connection lost', {
            source: 'Connection',
            body: 'The control-plane connection dropped. Reconnecting…',
          })
        }
      },
    )
  },
  deactivate() {
    stopConnectionWatch?.()
    stopConnectionWatch = undefined
  },
})
