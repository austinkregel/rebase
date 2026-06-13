<script setup lang="ts">
import { computed } from 'vue'
import { ExclamationTriangleIcon } from '@heroicons/vue/20/solid'
import { useAgentsStore } from '@/stores/agents'
import { parseTelemetry } from '@/services/telemetry'
import MiniBar from './MiniBar.vue'

// Compact, glanceable per-device telemetry for the servers panel (1/6 width):
// three labeled utilization bars + a battery/temperature footer. No history.
const props = defineProps<{ clientId: string }>()
const agents = useAgentsStore()

const view = computed(() => parseTelemetry(agents.statsFor(props.clientId)))

const rows = computed(() => {
  const t = view.value
  if (!t) return []
  return [
    { key: 'cpu', label: 'cpu', pct: t.cpuPct, warn: false, title: '' },
    { key: 'mem', label: 'mem', pct: t.memPct, warn: false, title: '' },
    {
      key: 'disk',
      label: 'disk',
      pct: t.worstDiskPct,
      warn: t.diskWarning,
      title: t.worstDiskMount ? `${t.worstDiskMount} ${t.worstDiskPct}%` : '',
    },
  ].filter((r) => r.pct !== null)
})
</script>

<template>
  <div v-if="view && rows.length" class="mt-1 flex flex-col gap-[3px]">
    <div v-for="row in rows" :key="row.key" class="flex items-center gap-1.5" :title="row.title">
      <span class="w-[24px] shrink-0 text-[9px] uppercase tracking-wide text-subtle">{{ row.label }}</span>
      <MiniBar :pct="row.pct" class="flex-1" />
      <ExclamationTriangleIcon v-if="row.warn" class="size-2.5 shrink-0 text-red" />
      <span class="w-[26px] shrink-0 text-right text-[9px] tabular-nums text-subtle">{{ Math.round(row.pct ?? 0) }}%</span>
    </div>

    <div
      v-if="view.battery || view.maxTempC !== null"
      class="mt-[1px] flex items-center gap-2.5 text-[9px] tabular-nums text-subtle"
    >
      <span v-if="view.battery" class="flex items-center gap-1" title="battery">
        <!-- inline battery glyph -->
        <svg width="14" height="8" viewBox="0 0 28 16" class="shrink-0">
          <rect x="0.5" y="0.5" width="24" height="15" rx="2" fill="none" stroke="currentColor" />
          <rect x="25" y="5" width="3" height="6" rx="1" fill="currentColor" />
          <rect
            x="2" y="2" :width="0.2 * view.battery.percent" height="12" rx="1"
            :fill="view.battery.percent <= 15 ? 'var(--red)' : view.battery.charging ? 'var(--green)' : 'currentColor'"
          />
        </svg>
        {{ Math.round(view.battery.percent) }}%<span v-if="view.battery.charging" class="text-green">⚡</span>
      </span>

      <span
        v-if="view.maxTempC !== null"
        class="flex items-center gap-0.5"
        :class="{ 'text-red': view.tempWarning }"
        title="hottest sensor"
      >
        <!-- inline thermometer glyph -->
        <svg width="6" height="10" viewBox="0 0 6 12" class="shrink-0">
          <path d="M3 0.5a1.5 1.5 0 0 1 1.5 1.5v5a2.5 2.5 0 1 1-3 0v-5A1.5 1.5 0 0 1 3 0.5Z" fill="none" stroke="currentColor" />
          <circle cx="3" cy="9.5" r="1.3" fill="currentColor" />
        </svg>
        {{ Math.round(view.maxTempC) }}°
      </span>
    </div>
  </div>
</template>
