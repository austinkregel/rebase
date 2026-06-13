<script setup lang="ts">
import { computed } from 'vue'
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue'
import { BellIcon } from '@heroicons/vue/20/solid'
import { useSessionStore } from '@/stores/session'
import { useAgentsStore } from '@/stores/agents'
import Badge from '@/components/ui/Badge.vue'

// Status-bar bell + alert popover for the active server. Contributed by the
// notifications plugin (was baked into StatusTray).
const session = useSessionStore()
const agents = useAgentsStore()

const snapshot = computed(() =>
  session.activeClientId ? agents.alertsFor(session.activeClientId) : undefined,
)
const alertItems = computed(() => snapshot.value?.alerts ?? [])
const alertCount = computed(() => snapshot.value?.totalCount ?? 0)
const alertCritical = computed(() => !!snapshot.value?.hasCritical)
</script>

<template>
  <Popover class="relative flex">
    <PopoverButton
      class="relative flex items-center text-subtle outline-none hover:text-fg"
      :class="{ 'text-red': alertCritical, 'text-yellow': alertCount && !alertCritical }"
      title="notifications"
      aria-label="notifications"
    >
      <BellIcon class="size-4" />
      <span
        v-if="alertCount"
        class="absolute -right-1.5 -top-1 rounded-full px-1 text-2xs leading-[1.4] tabular-nums"
        :class="alertCritical ? 'bg-red text-bg' : 'bg-yellow text-bg'"
      >{{ alertCount > 99 ? '99+' : alertCount }}</span>
    </PopoverButton>
    <PopoverPanel
      class="absolute bottom-6 right-0 z-50 max-h-80 w-80 overflow-auto rounded border border-line bg-elevated p-1 text-xs shadow-lg"
    >
      <p v-if="!session.activeClientId" class="p-2 text-subtle">no server selected</p>
      <p v-else-if="!alertItems.length" class="p-2 text-subtle">no alerts</p>
      <ul v-else class="flex flex-col gap-0.5">
        <li v-for="(a, i) in alertItems" :key="a.id ?? i" class="rounded px-2 py-1 hover:bg-hover">
          <div class="flex items-center gap-1.5">
            <Badge uppercase :tone="a.severity === 'critical' ? 'danger' : a.severity === 'warning' ? 'warn' : 'neutral'">
              {{ a.severity || 'info' }}
            </Badge>
            <span class="text-muted">{{ a.category }}</span>
            <span v-if="a.count && a.count > 1" class="ml-auto text-subtle">×{{ a.count }}</span>
          </div>
          <p class="mt-0.5 break-words text-fg">{{ a.message }}</p>
        </li>
      </ul>
    </PopoverPanel>
  </Popover>
</template>
