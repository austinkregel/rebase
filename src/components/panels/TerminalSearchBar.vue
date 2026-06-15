<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { SearchAddon } from '@xterm/addon-search'
import { ChevronDownIcon, ChevronUpIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/vue/20/solid'
import IconButton from '@/components/ui/IconButton.vue'
import Button from '@/components/ui/Button.vue'

// Floating find widget for the terminal. Unlike InlineInput (commit-on-blur,
// Esc=cancel) a find bar is persistent and live, so it's a bespoke terminal
// sub-component. Drives the xterm SearchAddon and shows match counts.
const props = defineProps<{ search: SearchAddon }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const caseSensitive = ref(false)
const resultCount = ref(0)
const resultIndex = ref(-1)

// Token-derived match highlight colors (yellow matches, accent active match).
const decorations = {
  matchBackground: '#e0af6855',
  matchBorder: '#e0af6800',
  matchOverviewRuler: '#e0af68',
  activeMatchBackground: '#7aa2f755',
  activeMatchBorder: '#7aa2f700',
  activeMatchColorOverviewRuler: '#7aa2f7',
}

function options(incremental = false) {
  return { caseSensitive: caseSensitive.value, decorations, incremental }
}

function runFind(incremental = false) {
  if (!query.value) {
    props.search.clearDecorations()
    resultCount.value = 0
    resultIndex.value = -1
    return
  }
  props.search.findNext(query.value, options(incremental))
}
function next() {
  if (query.value) props.search.findNext(query.value, options())
}
function prev() {
  if (query.value) props.search.findPrevious(query.value, options())
}
function toggleCase() {
  caseSensitive.value = !caseSensitive.value
  runFind()
}

let stopResults: { dispose: () => void } | undefined
onMounted(() => {
  stopResults = props.search.onDidChangeResults((e) => {
    resultCount.value = e.resultCount
    resultIndex.value = e.resultIndex
  })
  input.value?.focus()
})
onBeforeUnmount(() => {
  stopResults?.dispose()
  props.search.clearDecorations()
})
</script>

<template>
  <div
    class="flex items-center gap-1 rounded-md border border-line bg-elevated px-2 py-1 shadow-lg"
    @keydown.stop
  >
    <MagnifyingGlassIcon class="size-3.5 shrink-0 text-subtle" />
    <input
      ref="input"
      v-model="query"
      class="w-36 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
      placeholder="Find"
      spellcheck="false"
      @input="runFind(true)"
      @keydown.enter.prevent="$event.shiftKey ? prev() : next()"
      @keydown.esc.prevent="emit('close')"
    />
    <span
      v-if="query"
      class="shrink-0 text-2xs tabular-nums"
      :class="resultCount ? 'text-subtle' : 'text-red'"
    >{{ resultCount ? `${resultIndex + 1} of ${resultCount}` : 'No results' }}</span>
    <Button
      variant="ghost"
      title="Match case"
      class="!px-1.5 !py-0.5 text-2xs font-semibold"
      :class="caseSensitive ? 'rounded bg-accent/10 text-accent' : 'text-subtle'"
      @click="toggleCase"
    >Aa</Button>
    <IconButton :icon="ChevronUpIcon" label="Previous match" variant="ghost" @click="prev" />
    <IconButton :icon="ChevronDownIcon" label="Next match" variant="ghost" @click="next" />
    <IconButton :icon="XMarkIcon" label="Close find" variant="ghost" @click="emit('close')" />
  </div>
</template>
