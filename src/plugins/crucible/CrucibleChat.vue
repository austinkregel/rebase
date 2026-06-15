<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
  DocumentTextIcon,
  SparklesIcon,
} from '@heroicons/vue/20/solid'
import { isTauri } from '@/transport/contract'
import { useProjectsStore } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { useSettingsStore } from '@/stores/settings'
import { ask, stop, isStreaming, chatOptions } from '@/services/crucibleChat'
import { rebuild } from '@/services/crucible'
import { turnsFor, pinsFor, removePin, indexStateFor, type Citation } from '@/services/crucibleState'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import Button from '@/components/ui/Button.vue'
import IconButton from '@/components/ui/IconButton.vue'

const projects = useProjectsStore()
const session = useSessionStore()
const files = useFilesStore()
const settings = useSettingsStore()

const supported = isTauri()
const project = computed(() => projects.active)
const turns = computed(() => (project.value ? turnsFor(project.value.id) : []))
const pins = computed(() => (project.value ? pinsFor(project.value.id) : []))
const streaming = computed(() => !!project.value && isStreaming(project.value.id))
const index = computed(() => (project.value ? indexStateFor(project.value.id) : { phase: 'idle' as const }))
const hasIndex = computed(() => index.value.phase === 'ready' || !!index.value.lastIndexedAt)

const draft = ref('')
const scroller = ref<HTMLElement | null>(null)

// Keep the transcript pinned to the latest token as the answer streams in.
watch(
  () => turns.value.map((t) => t.text.length).join(','),
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function send() {
  const p = project.value
  if (!p || !draft.value.trim() || streaming.value) return
  const text = draft.value
  draft.value = ''
  void ask(p, text, pins.value.map((x) => ({ path: x.path, clientId: x.clientId })))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function openCitation(c: Citation) {
  const p = project.value
  const clientId = session.activeClientId
  if (!p || !clientId) return
  const root = (p.rootPaths[0] ?? files.rootPath).replace(/\/$/, '')
  void files.openFile(clientId, `${root}/${c.relative}`)
}

function refresh() {
  if (project.value) void rebuild(project.value)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <SectionHeader>
      crucible
      <template #actions>
        <span class="text-2xs lowercase tracking-normal text-subtle">{{ settings.indexing.chatModel }}</span>
      </template>
    </SectionHeader>

    <template v-if="!supported">
      <p class="m-3 text-sm text-subtle">Crucible runs in the desktop app.</p>
    </template>

    <template v-else-if="!project">
      <div class="m-auto flex flex-col items-center gap-1 px-6 text-center text-subtle">
        <SparklesIcon class="size-5" />
        <p class="text-sm">Open a project to chat with Crucible.</p>
      </div>
    </template>

    <template v-else>
      <!-- Transcript -->
      <div ref="scroller" class="flex-1 overflow-auto px-3 py-2">
        <div v-if="!turns.length" class="mt-6 flex flex-col items-center gap-2 px-4 text-center text-subtle">
          <SparklesIcon class="size-5" />
          <p class="text-sm">Ask about your code.</p>
          <p v-if="!hasIndex" class="text-xs">
            Build an index so answers are grounded in this project.
          </p>
          <Button v-if="!hasIndex" variant="primary" @click="refresh">Build index</Button>
        </div>

        <div v-for="t in turns" :key="t.id" class="mb-3">
          <!-- System note (e.g. allowlist grant) -->
          <p v-if="t.role === 'system'" class="rounded bg-elevated px-2 py-1 text-2xs italic text-subtle">
            {{ t.text }}
          </p>

          <template v-else>
            <span class="mb-0.5 block text-2xs uppercase tracking-[0.1em] text-subtle">
              {{ t.role === 'user' ? 'you' : 'crucible' }}
            </span>
            <div
              class="whitespace-pre-wrap break-words rounded px-2 py-1.5 text-sm"
              :class="t.role === 'user' ? 'bg-elevated text-fg' : 'text-fg'"
            >
              {{ t.text }}<span v-if="t.streaming" class="animate-pulse">▋</span>
            </div>

            <p v-if="t.error" class="mt-1 px-2 text-xs text-red">{{ t.error }}</p>

            <!-- Citations -->
            <div v-if="t.citations?.length" class="mt-1 flex flex-wrap gap-1 px-2">
              <button
                v-for="(c, i) in t.citations"
                :key="i"
                class="flex max-w-full items-center gap-1 rounded border border-line bg-elevated px-1.5 py-0.5 text-2xs text-subtle hover:border-accent hover:text-fg"
                :title="`${c.relative}:${c.lineStart}`"
                @click="openCitation(c)"
              >
                <DocumentTextIcon class="size-3 shrink-0" />
                <span class="overflow-hidden text-ellipsis whitespace-nowrap">
                  {{ basename(c.relative) }}:{{ c.lineStart }}
                </span>
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- Composer -->
      <div class="border-t border-line p-2">
        <!-- Pinned context files -->
        <div v-if="pins.length" class="mb-1.5 flex flex-wrap gap-1">
          <span
            v-for="p in pins"
            :key="p.path"
            class="flex items-center gap-1 rounded border border-line bg-elevated px-1.5 py-0.5 text-2xs text-subtle"
            :title="p.path"
          >
            @{{ basename(p.path) }}
            <button class="hover:text-fg" @click="removePin(project.id, p.path)">
              <XMarkIcon class="size-3" />
            </button>
          </span>
        </div>

        <div class="rounded border border-line bg-elevated focus-within:border-accent">
          <textarea
            v-model="draft"
            rows="3"
            class="block w-full resize-none bg-transparent px-2 py-1.5 text-sm text-fg outline-none placeholder:text-subtle"
            placeholder="ask about your code…  (Enter to send, Shift+Enter for newline)"
            spellcheck="false"
            @keydown="onKeydown"
          />
          <div class="flex items-center justify-between px-2 py-1">
            <label class="flex cursor-pointer items-center gap-1 text-2xs text-subtle">
              <input v-model="chatOptions.autoContext" type="checkbox" class="accent-accent" />
              auto context
            </label>
            <Button v-if="streaming" variant="secondary" @click="stop">
              <StopIcon class="size-4" /> stop
            </Button>
            <IconButton
              v-else
              :icon="PaperAirplaneIcon"
              label="send"
              size="md"
              :disabled="!draft.trim()"
              @click="send"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
