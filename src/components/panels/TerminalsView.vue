<script setup lang="ts">
import { computed } from 'vue'
import { PlusIcon, XMarkIcon } from '@heroicons/vue/20/solid'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import IconButton from '@/components/ui/IconButton.vue'
import Button from '@/components/ui/Button.vue'
import { dock } from '@/services/dock'
import {
  activeTerminalPanelId,
  terminalEntries,
  type TerminalEntry,
  type TerminalStatus,
} from '@/services/terminals'

// Tools-column view listing every open terminal: status, label, bound server,
// click-to-focus, per-row kill. Reads the shared terminals registry; the panels
// themselves live in the Workbench's dockview.
const entries = computed(() => terminalEntries())
const activeId = computed(() => activeTerminalPanelId())

const DOT: Record<TerminalStatus, string> = {
  connecting: 'bg-yellow',
  live: 'bg-green',
  closed: 'bg-subtle',
  error: 'bg-red',
}

function focus(entry: TerminalEntry) {
  dock.focusTerminal?.(entry.panelId)
}
function kill(entry: TerminalEntry) {
  // Closing the dockview panel unmounts Terminal.vue, which closes the shell and
  // deregisters the entry.
  dock.closeTerminal?.(entry.panelId)
}
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <SectionHeader>
      terminals
      <template #actions>
        <IconButton :icon="PlusIcon" label="New terminal" @click="dock.openTerminal?.()" />
      </template>
    </SectionHeader>

    <div class="min-h-0 flex-1 overflow-auto py-1">
      <template v-if="entries.length">
        <button
          v-for="entry in entries"
          :key="entry.panelId"
          class="group flex w-full items-center gap-1.5 px-3 py-[5px] text-left text-sm"
          :class="entry.panelId === activeId ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          @click="focus(entry)"
        >
          <span class="size-1.5 shrink-0 rounded-full" :class="DOT[entry.status]" />
          <span class="min-w-0 flex-1 truncate text-fg">{{ entry.title }}</span>
          <span class="max-w-[5rem] shrink-0 truncate text-xs text-subtle" :title="entry.clientId">
            {{ entry.clientId }}
          </span>
          <IconButton
            :icon="XMarkIcon"
            label="Kill terminal"
            variant="plain"
            class="opacity-0 group-hover:opacity-100"
            @click.stop="kill(entry)"
          />
        </button>
      </template>

      <div v-else class="px-3 py-2">
        <p class="text-sm text-subtle">No terminals open.</p>
        <Button variant="ghost" class="mt-1 !px-0" @click="dock.openTerminal?.()">
          <PlusIcon class="size-3.5" /> New terminal
        </Button>
      </div>
    </div>
  </div>
</template>
