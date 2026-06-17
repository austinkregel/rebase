<script setup lang="ts">
import { computed, type FunctionalComponent } from 'vue'

// Icon-only button with standardized chrome + accessible label. The icon size
// follows the app convention: sm=14px (row/action, default), md=16px (toolbar),
// lg=24px (nav). chevrons/markers that aren't buttons use a raw size-3 icon.
const props = withDefaults(
  defineProps<{
    icon: FunctionalComponent
    label: string
    size?: 'sm' | 'md' | 'lg'
    variant?: 'ghost' | 'plain'
    type?: 'button' | 'submit'
    disabled?: boolean
  }>(),
  { size: 'sm', variant: 'ghost', type: 'button', disabled: false },
)

const iconClass = computed(
  () => ({ sm: 'size-3.5', md: 'size-4', lg: 'size-5' })[props.size],
)
// ghost = padded hover chip; plain = bare icon that only shifts color on hover.
const chromeClass = computed(() =>
  props.variant === 'plain'
    ? 'text-subtle hover:text-fg'
    : 'rounded p-1 text-subtle hover:bg-hover hover:text-fg',
)
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :title="label"
    :aria-label="label"
    class="inline-flex shrink-0 items-center justify-center outline-none transition-colors disabled:opacity-50"
    :class="chromeClass"
  >
    <component :is="icon" :class="iconClass" />
  </button>
</template>
