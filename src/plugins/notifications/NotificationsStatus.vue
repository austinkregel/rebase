<script setup lang="ts">
import { computed } from 'vue'
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue'
import { BellIcon } from '@heroicons/vue/20/solid'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import NotificationCard from './NotificationCard.vue'
import { clear, dismiss, markAllRead, notifications, unreadCount } from '@/services/notifications'

// Status-bar bell + notification center. The center merges the live per-agent
// alert snapshot (a pinned "System" group) with the app's own notification
// history. Contributed by the notifications plugin.
const session = useSessionStore()
const agents = useAgentsStore()

const items = computed(() => notifications())
const unread = computed(() => unreadCount())

const snapshot = computed(() =>
  session.activeClientId ? agents.alertsFor(session.activeClientId) : undefined,
)
const agentAlerts = computed(() => snapshot.value?.alerts ?? [])
const agentCritical = computed(() => !!snapshot.value?.hasCritical)

// Bell tint + badge reflect the most urgent unseen signal across both sources.
const unreadError = computed(() => items.value.some((n) => !n.read && n.level === 'error'))
const unreadWarning = computed(() => items.value.some((n) => !n.read && n.level === 'warning'))
const tone = computed<'red' | 'yellow' | 'none'>(() => {
  if (agentCritical.value || unreadError.value) return 'red'
  if (agentAlerts.value.length || unreadWarning.value) return 'yellow'
  return 'none'
})
const isEmpty = computed(() => !agentAlerts.value.length && !items.value.length)

function alertTone(severity?: string) {
  return severity === 'critical' ? 'danger' : severity === 'warning' ? 'warn' : 'neutral'
}
</script>

<template>
  <Popover class="relative flex">
    <PopoverButton
      class="relative flex items-center text-subtle outline-none hover:text-fg"
      :class="{ 'text-red': tone === 'red', 'text-yellow': tone === 'yellow' }"
      title="notifications"
      aria-label="notifications"
      @click="markAllRead()"
    >
      <BellIcon class="size-4" />
      <span
        v-if="unread"
        class="absolute -right-1.5 -top-1 rounded-full px-1 text-2xs leading-[1.4] tabular-nums text-bg"
        :class="tone === 'red' ? 'bg-red' : tone === 'yellow' ? 'bg-yellow' : 'bg-accent'"
      >{{ unread > 99 ? '99+' : unread }}</span>
      <span
        v-else-if="agentAlerts.length"
        class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full"
        :class="tone === 'red' ? 'bg-red' : 'bg-yellow'"
      />
    </PopoverButton>

    <PopoverPanel
      class="absolute bottom-6 right-0 z-50 flex max-h-[28rem] w-96 flex-col overflow-hidden rounded-lg border border-line bg-elevated shadow-xl shadow-black/30"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span class="text-sm font-medium text-fg">Notifications</span>
        <span class="ml-auto flex gap-1">
          <Button v-if="items.length" variant="ghost" class="!px-2 !py-0.5" @click="clear()">Clear all</Button>
        </span>
      </header>

      <div class="min-h-0 flex-1 overflow-auto p-2">
        <p v-if="isEmpty" class="px-1 py-6 text-center text-xs text-subtle">You're all caught up</p>

        <!-- Live System group: the active agent's alert snapshot. -->
        <section v-if="agentAlerts.length" class="mb-2">
          <p class="px-1 pb-1 text-2xs uppercase tracking-wide text-subtle">System</p>
          <ul class="flex flex-col gap-1">
            <li
              v-for="(a, i) in agentAlerts"
              :key="a.id ?? i"
              class="rounded-lg border border-line bg-surface px-2.5 py-2"
            >
              <div class="flex items-center gap-1.5">
                <Badge uppercase :tone="alertTone(a.severity)">{{ a.severity || 'info' }}</Badge>
                <span class="text-2xs uppercase tracking-wide text-subtle">{{ a.category }}</span>
                <span v-if="a.count && a.count > 1" class="ml-auto text-2xs text-subtle">×{{ a.count }}</span>
              </div>
              <p class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-fg">{{ a.message }}</p>
            </li>
          </ul>
        </section>

        <!-- App notification history. -->
        <section v-if="items.length">
          <p v-if="agentAlerts.length" class="px-1 pb-1 text-2xs uppercase tracking-wide text-subtle">Recent</p>
          <ul class="flex flex-col gap-1">
            <li v-for="n in items" :key="n.id">
              <NotificationCard :notification="n" @dismiss="dismiss(n.id)" />
            </li>
          </ul>
        </section>
      </div>
    </PopoverPanel>
  </Popover>
</template>
