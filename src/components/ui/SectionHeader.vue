<script setup lang="ts">
// Standard panel section header: an uppercase label with an optional trailing
// actions slot. One rhythm for every panel (replaces 4–6 hand-tuned variants).
withDefaults(defineProps<{ bordered?: boolean }>(), { bordered: true })
</script>

<template>
  <header
    class="flex flex-shrink-0 items-center justify-between px-3 py-1.5"
    :class="bordered && 'border-b border-line'"
  >
    <span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs uppercase tracking-[0.12em] text-subtle">
      <slot />
    </span>
    <span v-if="$slots.actions" class="flex shrink-0 items-center gap-1">
      <slot name="actions" />
    </span>
  </header>
</template>
