<script setup lang="ts">
import { Switch } from '@headlessui/vue'
import { useSettingsStore } from '@/stores/settings'
import type { EditorSettings } from '@/cm/setup'

const settings = useSettingsStore()

const toggles: { key: keyof EditorSettings; label: string }[] = [
  { key: 'lineNumbers', label: 'Line numbers' },
  { key: 'lineWrapping', label: 'Soft wrap' },
  { key: 'highlightActiveLine', label: 'Highlight active line' },
  { key: 'foldGutter', label: 'Code folding gutter' },
  { key: 'bracketMatching', label: 'Bracket matching' },
  { key: 'closeBrackets', label: 'Auto-close brackets' },
  { key: 'autocomplete', label: 'Autocompletion' },
  { key: 'indentWithTabs', label: 'Indent with tabs' },
]
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-auto">
    <p class="border-b border-line px-3 py-2 text-[10.5px] uppercase tracking-[0.1em] text-subtle">
      editor
    </p>
    <div class="flex flex-col gap-3 p-3">
      <label class="flex items-center justify-between gap-3">
        <span class="text-[12.5px] text-fg">Font size</span>
        <input
          type="number"
          min="9"
          max="28"
          :value="settings.editor.fontSize"
          class="w-16 rounded border border-line bg-elevated px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
          @change="settings.update({ fontSize: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="flex items-center justify-between gap-3">
        <span class="text-[12.5px] text-fg">Tab size</span>
        <input
          type="number"
          min="1"
          max="8"
          :value="settings.editor.tabSize"
          class="w-16 rounded border border-line bg-elevated px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
          @change="settings.update({ tabSize: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <div v-for="t in toggles" :key="t.key" class="flex items-center justify-between gap-3">
        <span class="text-[12.5px] text-fg">{{ t.label }}</span>
        <Switch
          :model-value="settings.editor[t.key] as boolean"
          class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
          :class="settings.editor[t.key] ? 'bg-accent' : 'bg-line'"
          @update:model-value="settings.update({ [t.key]: $event } as Partial<EditorSettings>)"
        >
          <span
            class="inline-block size-3 transform rounded-full bg-bg transition-transform"
            :class="settings.editor[t.key] ? 'translate-x-3.5' : 'translate-x-0.5'"
          />
        </Switch>
      </div>
    </div>
  </div>
</template>
