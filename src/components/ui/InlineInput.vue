<script setup lang="ts">
import { nextTick, onMounted, ref, type FunctionalComponent } from 'vue'

// The rename / new-file / new-folder field: autofocuses + selects, commits on
// Enter or blur, cancels on Esc. Emits the trimmed value once (Enter then blur
// won't double-fire). An optional leading icon mirrors the row it replaces.
const props = withDefaults(
  defineProps<{ initial?: string; placeholder?: string; icon?: FunctionalComponent }>(),
  { initial: '' },
)
const emit = defineEmits<{ commit: [value: string]; cancel: [] }>()

const value = ref(props.initial)
const el = ref<HTMLInputElement | null>(null)
let settled = false

onMounted(async () => {
  await nextTick()
  el.value?.focus()
  el.value?.select()
})

function commit() {
  if (settled) return
  settled = true
  emit('commit', value.value.trim())
}
function cancel() {
  if (settled) return
  settled = true
  emit('cancel')
}
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-1.5">
    <component :is="icon" v-if="icon" class="size-3.5 shrink-0 text-subtle" />
    <input
      ref="el"
      v-model="value"
      :placeholder="placeholder"
      class="min-w-0 flex-1 rounded border border-accent bg-elevated px-1 text-sm text-fg outline-none"
      spellcheck="false"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @blur="commit"
    />
  </div>
</template>
