<script setup lang="ts">
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { MagnifyingGlassIcon, DocumentTextIcon } from '@heroicons/vue/20/solid'
import { isTauri } from '@/transport/contract'
import { useSettingsStore } from '@/stores/settings'
import { useSessionStore } from '@/stores/session'
import { useProjectsStore } from '@/stores/projects'
import { useFilesStore } from '@/stores/files'
import SectionHeader from './ui/SectionHeader.vue'
import Button from './ui/Button.vue'

interface Hit {
  relative: string
  language: string
  line_start: number
  line_end: number
  distance: number
  text: string
}

const settings = useSettingsStore()
const session = useSessionStore()
const projects = useProjectsStore()
const files = useFilesStore()

const query = ref('')
const results = ref<Hit[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const supported = isTauri()

async function run() {
  if (!query.value.trim() || !settings.indexing.indexPath) return
  busy.value = true
  error.value = null
  results.value = []
  try {
    results.value = await invoke<Hit[]>('search_code', {
      indexPath: settings.indexing.indexPath,
      query: query.value,
      ollama: settings.indexing.ollamaUrl,
      model: settings.indexing.embedModel,
      k: 20,
    })
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

// Open the hit's file in the editor (resolved against the active project's root).
function open(h: Hit) {
  const clientId = session.activeClientId
  if (!clientId) return
  const root = (projects.active?.rootPaths[0] ?? files.rootPath).replace(/\/$/, '')
  void files.openFile(clientId, `${root}/${h.relative}`)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <SectionHeader>search</SectionHeader>

    <template v-if="supported">
      <div class="flex flex-col gap-2 border-b border-line p-3">
        <input
          v-model="settings.indexing.indexPath"
          class="w-full rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
          placeholder="/path/to/project/.rebase-index"
          spellcheck="false"
          autocomplete="off"
          @change="settings.updateIndexing({ indexPath: settings.indexing.indexPath })"
        />
        <form class="flex gap-1" @submit.prevent="run">
          <input
            v-model="query"
            class="min-w-0 flex-1 rounded border border-line bg-elevated px-2 py-1 text-sm text-fg outline-none focus:border-accent"
            placeholder="semantic search…"
          />
          <Button variant="primary" type="submit" :disabled="busy">
            <MagnifyingGlassIcon class="size-4" />
          </Button>
        </form>
      </div>

      <div class="flex-1 overflow-auto py-1">
        <p v-if="busy" class="mx-3 my-2 text-sm text-subtle">searching…</p>
        <p v-else-if="error" class="mx-3 my-2 text-sm text-red">{{ error }}</p>
        <p v-else-if="!results.length" class="mx-3 my-2 text-sm text-subtle">No results yet.</p>
        <button
          v-for="(h, i) in results"
          :key="i"
          class="block w-full px-3 py-1.5 text-left hover:bg-hover"
          :title="h.relative"
          @click="open(h)"
        >
          <span class="flex items-center gap-1.5 text-sm text-fg">
            <DocumentTextIcon class="size-3 shrink-0 text-subtle" />
            <span class="overflow-hidden text-ellipsis whitespace-nowrap">{{ basename(h.relative) }}</span>
            <span class="ml-auto shrink-0 text-2xs text-subtle">d={{ h.distance.toFixed(2) }}</span>
          </span>
          <span class="block overflow-hidden text-ellipsis whitespace-nowrap text-xs text-subtle">
            {{ h.relative }}:{{ h.line_start }}
          </span>
        </button>
      </div>
    </template>

    <p v-else class="m-3 text-sm text-subtle">Code search runs in the desktop app.</p>
  </div>
</template>
