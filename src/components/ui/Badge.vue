<script setup lang="ts">
import { computed } from 'vue'

// Small status pill (P2P, alert counts, severity, …).
const props = withDefaults(
  defineProps<{ tone?: 'accent' | 'warn' | 'danger' | 'neutral'; uppercase?: boolean }>(),
  { tone: 'neutral', uppercase: false },
)

const toneClass = computed(
  () =>
    ({
      accent: 'bg-accent/15 text-accent',
      warn: 'bg-yellow/20 text-yellow',
      danger: 'bg-red/20 text-red',
      neutral: 'bg-line text-muted',
    })[props.tone],
)
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center rounded px-1 text-2xs tabular-nums tracking-wide"
    :class="[toneClass, uppercase && 'uppercase']"
  >
    <slot />
  </span>
</template>
