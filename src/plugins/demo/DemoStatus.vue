<script setup lang="ts">
import { ArrowPathIcon } from '@heroicons/vue/20/solid'
import IconButton from '@/components/ui/IconButton.vue'
import { runCommand } from '@/services/commands'
import { clockTime } from './state'

// Custom status-bar component — reads reactive state directly from state.ts.
// No props: the plugin host mounts this via component: markRaw(DemoStatus).
</script>

<template>
  <span class="flex items-center gap-1">
    <span class="tabular-nums text-subtle">{{ clockTime }}</span>
    <IconButton
      :icon="ArrowPathIcon"
      variant="plain"
      size="lg"
      label="Reset demo counter"
      @click="runCommand('demo.reset')"
    />
  </span>
</template>
