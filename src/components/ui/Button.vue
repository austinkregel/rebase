<script setup lang="ts">
import { computed } from 'vue'

// Text/standard button. Icon-only buttons use IconButton. Content (incl. a
// leading icon) goes in the default slot.
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    block?: boolean
    type?: 'button' | 'submit'
    disabled?: boolean
  }>(),
  { variant: 'secondary', size: 'sm', type: 'button', disabled: false },
)

const variantClass = computed(
  () =>
    ({
      primary: 'bg-accent text-bg font-semibold hover:opacity-90',
      secondary: 'border border-line text-muted hover:bg-hover hover:text-fg',
      ghost: 'text-subtle hover:text-fg',
      danger: 'bg-red text-bg hover:opacity-90',
    })[props.variant],
)

const sizeClass = computed(
  () => (props.size === 'md' ? 'rounded-md px-3.5 py-2 text-base' : 'rounded px-2.5 py-1 text-sm'),
)
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="inline-flex items-center gap-1.5 whitespace-nowrap outline-none transition-colors disabled:opacity-50"
    :class="[variantClass, sizeClass, block && 'w-full justify-center']"
  >
    <slot />
  </button>
</template>
