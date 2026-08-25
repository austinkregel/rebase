<script setup lang="ts">
import { computed } from 'vue'

// The app's one loading indicator. Inherits the ambient text color by default
// (tone 'current'), so it takes on whatever it sits inside — the bg-colored
// text of a primary button, text-red in an error row, muted text in a list.
// Sizes reuse the IconButton scale (sm=14px, md=16px) so it lines up with icons.
const props = withDefaults(
  defineProps<{
    size?: 'xs' | 'sm' | 'md'
    tone?: 'current' | 'accent' | 'muted'
    label?: string
    /**
     * Purely visual — no role/label. Use when a surrounding element already
     * announces the loading state (e.g. ActionButton's aria-live label), so the
     * spinner doesn't double-announce.
     */
    decorative?: boolean
  }>(),
  { size: 'sm', tone: 'current', label: 'Loading', decorative: false },
)

const sizeClass = computed(() => ({ xs: 'size-3', sm: 'size-3.5', md: 'size-4' })[props.size])
const toneClass = computed(
  () => ({ current: 'text-current', accent: 'text-accent', muted: 'text-subtle' })[props.tone],
)
</script>

<template>
  <svg
    class="shrink-0 animate-spin motion-reduce:animate-none"
    :class="[sizeClass, toneClass]"
    viewBox="0 0 24 24"
    fill="none"
    :role="decorative ? undefined : 'status'"
    :aria-label="decorative ? undefined : label"
    :aria-hidden="decorative || undefined"
  >
    <circle class="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" />
    <path
      class="opacity-90"
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
    />
  </svg>
</template>
