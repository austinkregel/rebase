<script setup lang="ts">
import { ref, watch } from 'vue'
import { Switch } from '@headlessui/vue'
import { useSettingsStore } from '@/stores/settings'
import type { EditorSettings } from '@/cm/setup'
import { applyAppearance, themePresets, accentSwatches, clampScale } from '@/services/appearance'
import SectionHeader from './ui/SectionHeader.vue'

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

// Applying the UI scale sets CSS `zoom` on <html>, which reflows the whole app —
// doing that mid-drag makes the UI jitter. So while dragging we only move the `%`
// label (no reflow); the zoom is applied and persisted once, on release (`@change`
// fires on mouse-up / after a keyboard step).
const scale = ref(settings.appearance.uiScale)
watch(() => settings.appearance.uiScale, (v) => (scale.value = v))

function previewScale(value: number) {
  scale.value = clampScale(value)
}
function commitScale() {
  applyAppearance({ ...settings.appearance, uiScale: scale.value })
  void settings.updateAppearance({ uiScale: scale.value })
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-auto">
    <SectionHeader>appearance</SectionHeader>
    <div class="flex flex-col gap-3 p-3">
      <!-- UI scale -->
      <label class="flex flex-col gap-1.5">
        <span class="flex items-center justify-between text-sm text-fg">
          UI scale
          <span class="tabular-nums text-muted">{{ Math.round(scale * 100) }}%</span>
        </span>
        <input
          type="range"
          min="0.8"
          max="1.5"
          step="0.05"
          :value="scale"
          class="w-full accent-accent"
          @input="previewScale(Number(($event.target as HTMLInputElement).value))"
          @change="commitScale"
        />
      </label>

      <!-- Theme preset -->
      <label class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">Theme</span>
        <select
          :value="settings.appearance.theme"
          class="rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          @change="settings.updateAppearance({ theme: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="p in themePresets" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </label>

      <!-- Accent -->
      <div class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">Accent</span>
        <div class="flex items-center gap-1.5">
          <button
            v-for="c in accentSwatches"
            :key="c"
            type="button"
            class="size-4 rounded-full border transition-transform hover:scale-110"
            :class="settings.appearance.accent === c ? 'border-fg' : 'border-line'"
            :style="{ backgroundColor: c }"
            :title="c"
            @click="settings.updateAppearance({ accent: c })"
          />
          <input
            type="color"
            :value="settings.appearance.accent"
            class="size-5 cursor-pointer rounded border border-line bg-transparent p-0"
            title="custom accent"
            @input="settings.updateAppearance({ accent: ($event.target as HTMLInputElement).value })"
          />
        </div>
      </div>
    </div>

    <SectionHeader>editor</SectionHeader>
    <div class="flex flex-col gap-3 p-3">
      <label class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">Font size</span>
        <input
          type="number"
          min="9"
          max="28"
          :value="settings.editor.fontSize"
          class="w-16 rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          @change="settings.update({ fontSize: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">Tab size</span>
        <input
          type="number"
          min="1"
          max="8"
          :value="settings.editor.tabSize"
          class="w-16 rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          @change="settings.update({ tabSize: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <div v-for="t in toggles" :key="t.key" class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">{{ t.label }}</span>
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

    <SectionHeader>crucible</SectionHeader>
    <div class="flex flex-col gap-3 p-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-sm text-fg">Ollama URL</span>
        <input
          :value="settings.indexing.ollamaUrl"
          class="w-full rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          placeholder="http://localhost:11434"
          spellcheck="false"
          autocomplete="off"
          @change="settings.updateIndexing({ ollamaUrl: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">Chat model</span>
        <input
          :value="settings.indexing.chatModel"
          class="w-44 rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          placeholder="qwen2.5-coder"
          spellcheck="false"
          autocomplete="off"
          @change="settings.updateIndexing({ chatModel: ($event.target as HTMLInputElement).value })"
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span class="text-sm text-fg">Embedding model</span>
        <input
          :value="settings.indexing.embedModel"
          class="w-44 rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          placeholder="nomic-embed-text"
          spellcheck="false"
          autocomplete="off"
          @change="settings.updateIndexing({ embedModel: ($event.target as HTMLInputElement).value })"
        />
      </label>
    </div>
  </div>
</template>
