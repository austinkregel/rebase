<script setup lang="ts">
import { computed } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { parseTelemetry, pctColor } from '@/services/telemetry'

const props = defineProps<{ clientId: string; metrics?: ('cpu' | 'mem' | 'disk')[]; showThermalOnly?: boolean }>()
const agents = useAgentsStore()

const view = computed(() => parseTelemetry(agents.statsFor(props.clientId)))

const rows = computed(() => {
  const t = view.value
  if (!t) return []
  const allRows = [
    { key: 'cpu', label: 'cpu', pct: t.cpuPct, warn: false, title: '' },
    { key: 'mem', label: 'mem', pct: t.memPct, warn: false, title: '' },
    {
      key: 'disk',
      label: 'disk',
      pct: t.rootDiskPct,
      warn: t.diskWarning,
      title: t.rootDiskMount ? `${t.rootDiskMount} ${t.rootDiskPct}%` : '',
    },
  ].filter((r) => r.pct !== null)

  if (props.metrics) {
    return allRows.filter(r => props.metrics!.includes(r.key as any))
  }
  return allRows
})
</script>

<template>
  <div
    v-if="view"
    class="flex flex-wrap items-center gap-x-2 gap-y-0 text-2xs tabular-nums"
  >
    <!-- Metrics (CPU/MEM/DISK) mode -->
    <template v-if="!showThermalOnly">
      <span v-for="row in rows" :key="row.key" class="flex items-center gap-1" :title="row.title">
        <span class="uppercase tracking-wide text-subtle">{{ row.label }}</span>
        <span :style="{ color: pctColor(row.pct) }">{{ Math.round(row.pct ?? 0) }}%</span>
      </span>
    </template>

    <!-- Thermal/Battery mode (temperature + battery + ping context) -->
    <template v-if="showThermalOnly">
      <span
        v-if="view.maxTempC !== null"
        class="flex items-center gap-0.5"
        :class="{ 'text-red': view.tempWarning }"
        title="hottest sensor"
      >
        <svg width="6" height="10" viewBox="0 0 6 12" class="shrink-0">
          <path d="M3 0.5a1.5 1.5 0 0 1 1.5 1.5v5a2.5 2.5 0 1 1-3 0v-5A1.5 1.5 0 0 1 3 0.5Z" fill="none" stroke="currentColor" />
          <circle cx="3" cy="9.5" r="1.3" fill="currentColor" />
        </svg>
        {{ Math.round(view.maxTempC) }}°
      </span>

      <span v-if="view.battery" class="flex items-center gap-1" title="battery">
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
    </template>
  </div>
</template>
