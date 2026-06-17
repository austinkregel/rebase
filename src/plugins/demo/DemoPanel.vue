<script setup lang="ts">
import { PlusIcon, ArrowPathIcon } from '@heroicons/vue/20/solid'
import Button from '@/components/ui/Button.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { runCommand } from '@/services/commands'
import { counter, clockTime, eventLog } from './state'
</script>

<template>
  <div class="flex flex-col overflow-hidden">
    <SectionHeader>Demo</SectionHeader>

    <div class="flex flex-col gap-4 overflow-auto p-3">

      <!-- Counter: exercises registerCommand via runCommand() -->
      <section>
        <p class="mb-1 text-2xs uppercase tracking-wide text-subtle">Counter</p>
        <p class="font-mono text-2xl tabular-nums text-fg">{{ counter }}</p>
        <div class="mt-2 flex gap-2">
          <Button variant="secondary" @click="runCommand('demo.increment')">
            <PlusIcon class="size-3.5" />
            Increment
          </Button>
          <Button variant="ghost" @click="runCommand('demo.reset')">
            <ArrowPathIcon class="size-3.5" />
            Reset
          </Button>
        </div>
      </section>

      <!-- Clock: exercises the module-level setInterval kept alive by the plugin -->
      <section>
        <p class="mb-1 text-2xs uppercase tracking-wide text-subtle">Clock (from status component)</p>
        <p class="font-mono text-sm tabular-nums text-fg">{{ clockTime }}</p>
      </section>

      <!-- Cheat sheet: surfaces all the plugin's contribution points -->
      <section>
        <p class="mb-1 text-2xs uppercase tracking-wide text-subtle">What's wired up</p>
        <ul class="flex flex-col gap-1 text-xs text-subtle">
          <li>Status bar left — <span class="font-mono text-fg">demo ×N</span> (click to increment)</li>
          <li>Status bar right — live clock + reset button</li>
          <li>Command palette — search "Demo" for all 3 commands</li>
          <li>Keybinding — <kbd class="rounded bg-elevated px-1 font-mono text-fg">⌘⇧D</kbd> fires a notification</li>
          <li>File/folder context menu — right-click any file or folder</li>
        </ul>
      </section>

      <!-- Event log: proves state flows between status bar → panel -->
      <section v-if="eventLog.length">
        <p class="mb-1 text-2xs uppercase tracking-wide text-subtle">Event log</p>
        <ul class="flex flex-col gap-0.5">
          <li
            v-for="(entry, i) in eventLog"
            :key="i"
            class="font-mono text-2xs text-subtle"
          >{{ entry }}</li>
        </ul>
      </section>

    </div>
  </div>
</template>
