<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import NotificationCard from '@/plugins/notifications/NotificationCard.vue'
import { activeToasts, dismissToast } from '@/services/notifications'

// App-wide toast overlay (a singleton, like ContextMenu/ConfirmDialog) shown
// bottom-right above the status tray. Newest sits nearest the tray. Each toast
// auto-dismisses after its lifetime; hovering pauses the countdown (ChromeOS
// behaviour), and sticky toasts (errors) never expire on their own.
const MAX_VISIBLE = 4

const toasts = computed(() => activeToasts().slice(-MAX_VISIBLE))

interface Timer {
  handle: ReturnType<typeof setTimeout>
  deadline: number
  remaining: number
  paused: boolean
}
const timers = new Map<string, Timer>()

function clearTimer(id: string) {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t.handle)
    timers.delete(id)
  }
}

function arm(id: string, ms: number) {
  clearTimer(id)
  timers.set(id, {
    handle: setTimeout(() => {
      timers.delete(id)
      dismissToast(id)
    }, ms),
    deadline: Date.now() + ms,
    remaining: ms,
    paused: false,
  })
}

function pause(id: string) {
  const t = timers.get(id)
  if (!t || t.paused) return
  clearTimeout(t.handle)
  t.remaining = Math.max(0, t.deadline - Date.now())
  t.paused = true
}

function resume(id: string) {
  const t = timers.get(id)
  if (!t || !t.paused) return
  arm(id, t.remaining)
}

// Reconcile timers with the visible toast set: arm new auto-dismiss toasts,
// drop timers for toasts that left.
watch(
  toasts,
  (list) => {
    const present = new Set(list.map((n) => n.id))
    for (const id of [...timers.keys()]) if (!present.has(id)) clearTimer(id)
    for (const n of list) {
      if (!n.sticky && n.timeoutMs > 0 && !timers.has(n.id)) arm(n.id, n.timeoutMs)
    }
  },
  { immediate: true, deep: true },
)

onBeforeUnmount(() => {
  for (const t of timers.values()) clearTimeout(t.handle)
  timers.clear()
})
</script>

<template>
  <div class="pointer-events-none fixed bottom-11 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
    <TransitionGroup name="toast">
      <div
        v-for="n in toasts"
        :key="n.id"
        class="pointer-events-auto shadow-lg shadow-black/30"
        @mouseenter="pause(n.id)"
        @mouseleave="resume(n.id)"
      >
        <NotificationCard :notification="n" toast @dismiss="dismissToast(n.id)" />
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(16px);
}
.toast-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
.toast-leave-active {
  position: absolute;
  right: 0;
  width: 100%;
}
</style>
