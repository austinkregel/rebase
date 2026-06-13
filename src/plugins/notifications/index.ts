import { markRaw } from 'vue'
import { definePlugin } from '@/services/plugins'
import NotificationsStatus from './NotificationsStatus.vue'

// Surfaces agent OS-alerts as a status-bar bell + popover.
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
  },
})
