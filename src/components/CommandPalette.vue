<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Dialog, DialogPanel, Combobox, ComboboxInput, ComboboxOptions, ComboboxOption } from '@headlessui/vue'
import { allCommands, closePalette, palette, runCommand, type Command } from '@/services/commands'
import { keybindingHint } from '@/services/keybindings'

const query = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

// Subsequence fuzzy match over "category title"; rank tighter matches first.
function score(text: string, q: string): number | null {
  if (!q) return 0
  const t = text.toLowerCase()
  let ti = 0
  let gaps = 0
  let firstIdx = -1
  for (const ch of q.toLowerCase()) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return null
    if (firstIdx === -1) firstIdx = found
    if (ti > 0 && found > ti) gaps += found - ti
    ti = found + 1
  }
  return firstIdx + gaps
}

const filtered = computed<Command[]>(() => {
  const q = query.value.trim()
  const enabled = allCommands().filter((c) => !c.isEnabled || c.isEnabled())
  const ranked = enabled
    .map((c) => ({ c, s: score(`${c.category ?? ''} ${c.title}`, q) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => (a.s as number) - (b.s as number) || a.c.title.localeCompare(b.c.title))
  return ranked.map((r) => r.c)
})

function onSelect(cmd: Command | null) {
  if (!cmd) return
  closePalette()
  void runCommand(cmd.id)
}

watch(
  () => palette.open,
  async (open) => {
    if (!open) return
    query.value = ''
    await nextTick()
    inputEl.value?.focus()
  },
)
</script>

<template>
  <Dialog :open="palette.open" class="relative z-[1200]" @close="closePalette">
    <div class="fixed inset-0 bg-black/40" aria-hidden="true" />
    <div class="fixed inset-0 flex items-start justify-center p-4 pt-[12vh]">
      <DialogPanel class="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-elevated shadow-2xl">
        <Combobox :model-value="null" @update:model-value="onSelect">
          <ComboboxInput
            ref="inputEl"
            class="w-full border-b border-line bg-transparent px-3 py-2.5 text-base text-fg outline-none placeholder:text-subtle"
            placeholder="Type a command…"
            :display-value="() => ''"
            autocomplete="off"
            spellcheck="false"
            @input="query = ($event.target as HTMLInputElement).value"
          />
          <ComboboxOptions static class="max-h-80 overflow-auto py-1">
            <p v-if="!filtered.length" class="px-3 py-2 text-sm text-subtle">No matching commands</p>
            <ComboboxOption
              v-for="cmd in filtered"
              :key="cmd.id"
              :value="cmd"
              v-slot="{ active }"
              as="template"
            >
              <li
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm"
                :class="active ? 'bg-accent/15 text-fg' : 'text-muted'"
              >
                <span v-if="cmd.category" class="shrink-0 text-xs text-subtle">{{ cmd.category }}:</span>
                <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{{ cmd.title }}</span>
                <kbd v-if="keybindingHint(cmd.id)" class="shrink-0 rounded border border-line px-1 text-2xs text-subtle">
                  {{ keybindingHint(cmd.id) }}
                </kbd>
              </li>
            </ComboboxOption>
          </ComboboxOptions>
        </Combobox>
      </DialogPanel>
    </div>
  </Dialog>
</template>
