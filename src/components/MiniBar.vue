<script setup lang="ts">
import { computed } from 'vue'
import { pctColor } from '@/services/telemetry'

// A tiny inline-SVG utilization bar sized for the 1/6-width servers panel:
// a full-width track with a colored fill. `pct` null renders an empty track.
const props = withDefaults(defineProps<{ pct: number | null; height?: number }>(), {
  height: 4,
})

const fillPct = computed(() => (props.pct === null ? 0 : Math.max(0, Math.min(100, props.pct))))
const color = computed(() => pctColor(props.pct))
</script>

<template>
  <svg class="block w-full" :height="height" :style="{ height: `${height}px` }" preserveAspectRatio="none" viewBox="0 0 100 10">
    <rect x="0" y="0" width="100" height="10" rx="2" fill="var(--elevated)" />
    <rect x="0" y="0" :width="fillPct" height="10" rx="2" :fill="color" />
  </svg>
</template>
