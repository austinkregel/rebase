<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
  SparklesIcon,
  ClockIcon,
  PencilSquareIcon,
} from '@heroicons/vue/20/solid'
import { isTauri } from '@/transport/contract'
import { useProjectsStore } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { useSettingsStore } from '@/stores/settings'
import { ask, stop, isStreaming, isStopping, chatOptions, resolveToolApproval, loadConversations, activateConversation, newConversation, type ApprovalDecision, type ChatMode } from '@/services/crucibleChat'
import { rebuild } from '@/services/crucible'
import { turnsFor, pinsFor, removePin, indexStateFor, conversationListFor, activeConversationIdFor, type Citation } from '@/services/crucibleState'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import Button from '@/components/ui/Button.vue'
import ActionButton from '@/components/ui/ActionButton.vue'
import IconButton from '@/components/ui/IconButton.vue'
import TranscriptTurn from './TranscriptTurn.vue'
import { activityKey, basename, groupTurns } from './transcript'

const projects = useProjectsStore()
const session = useSessionStore()
const files = useFilesStore()
const settings = useSettingsStore()

const supported = isTauri()
const project = computed(() => projects.active)
const turns = computed(() => (project.value ? turnsFor(project.value.id) : []))
const groupedTurns = computed(() => groupTurns(turns.value))
const pins = computed(() => (project.value ? pinsFor(project.value.id) : []))
const streaming = computed(() => !!project.value && isStreaming(project.value.id))
// Stop is acknowledged instantly even though the run takes a moment to unwind —
// the composer stays locked until it does, so a second send can't interleave.
const stopping = computed(() => !!project.value && isStopping(project.value.id))
const index = computed(() => (project.value ? indexStateFor(project.value.id) : { phase: 'idle' as const }))
const hasIndex = computed(() => index.value.phase === 'ready' || !!index.value.lastIndexedAt)

const draft = ref('')
const scroller = ref<HTMLElement | null>(null)
const view = ref<'chat' | 'history'>('chat')

const conversationList = computed(() =>
  project.value ? conversationListFor(project.value.id) : [],
)
const activeConvId = computed(() =>
  project.value ? activeConversationIdFor(project.value.id) : undefined,
)

// Load conversations when the active project changes; reset to chat view.
watch(
  () => project.value?.id,
  (pid) => {
    if (pid) {
      view.value = 'chat'
      void loadConversations(pid)
    }
  },
  { immediate: true },
)

function formatDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

async function startNew() {
  const p = project.value
  if (!p) return
  await newConversation(p.id)
  view.value = 'chat'
}

async function openConversation(id: string) {
  const p = project.value
  if (!p) return
  await activateConversation(p.id, id)
  view.value = 'chat'
}

// Keep the transcript pinned to the latest token / tool activity.
watch(
  () => activityKey(turns.value),
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function approve(callId: string, decision: ApprovalDecision) {
  resolveToolApproval(callId, decision)
}

function send() {
  const p = project.value
  if (!p || !draft.value.trim() || streaming.value) return
  const text = draft.value
  draft.value = ''
  void ask(p, text, pins.value.map((x) => ({ path: x.path, clientId: x.clientId })))
}

const MODES: ChatMode[] = ['agent', 'plan', 'multi-task', 'ask']

function cycleMode() {
  const idx = MODES.indexOf(chatOptions.mode)
  chatOptions.mode = MODES[(idx + 1) % MODES.length]
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault()
    cycleMode()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
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

// Map the 7-phase index machine onto the button's four states, with a distinct
// in-flight label per phase so the long build reports what it's doing.
const indexActionState = computed(() => {
  switch (index.value.phase) {
    case 'uploading':
    case 'building':
    case 'packing':
    case 'downloading':
      return 'pending' as const
    case 'ready':
      return 'success' as const
    case 'error':
      return 'error' as const
    default:
      return 'idle' as const
  }
})
const PHASE_LABELS: Record<string, string> = {
  uploading: 'Uploading indexer…',
  building: 'Building index…',
  packing: 'Packing…',
  downloading: 'Downloading…',
}
const indexPhaseLabel = computed(() => PHASE_LABELS[index.value.phase])
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-surface">
    <SectionHeader>
      crucible
      <template #actions>
        <span class="text-2xs lowercase tracking-normal text-subtle">{{ settings.indexing.chatModel }}</span>
        <div v-if="project" class="flex items-center gap-2">
          <IconButton
            :icon="PencilSquareIcon"
            label="new conversation"
            variant="plain"
            size="lg"
            title="New conversation"
            @click="startNew"
          />
          <IconButton
            :icon="ClockIcon"
            label="conversation history"
            variant="plain"
            size="lg"
            :title="view === 'history' ? 'Back to chat' : 'Conversation history'"
            @click="view = view === 'history' ? 'chat' : 'history'"
          />
        </div>
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
      <!-- History view: list of past conversations -->
      <template v-if="view === 'history'">
        <div class="flex-1 overflow-auto px-3 py-2">
          <p v-if="!conversationList.length" class="mt-6 text-center text-sm text-subtle">
            No previous conversations.
          </p>
          <button
            v-for="c in conversationList"
            :key="c.id"
            class="mb-1 w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-elevated"
            :class="c.id === activeConvId ? 'bg-elevated' : ''"
            @click="openConversation(c.id)"
          >
            <p class="truncate text-sm text-fg">{{ c.title }}</p>
            <p class="text-2xs text-subtle">{{ formatDate(c.lastMessageAt) }}</p>
          </button>
        </div>
      </template>

      <!-- Chat view: transcript + composer -->
      <template v-else>
      <!-- Transcript -->
      <div ref="scroller" class="flex-1 overflow-auto px-3 py-2">
        <div v-if="!turns.length" class="mt-6 flex flex-col items-center gap-2 px-4 text-center text-subtle">
          <SparklesIcon class="size-5" />
          <p class="text-sm">Ask about your code.</p>
          <p v-if="!hasIndex" class="text-xs">
            Build an index so answers are grounded in this project.
          </p>
          <ActionButton
            v-if="!hasIndex"
            label="Build index"
            :states="{ success: 'Index built', error: 'Build failed' }"
            :state="indexActionState"
            :phase-label="indexPhaseLabel"
            variant="primary"
            @trigger="refresh"
            @retry="refresh"
          />
        </div>

        <TranscriptTurn
          v-for="t in groupedTurns"
          :key="t.id"
          :turn="t"
          @approve="approve"
          @open-citation="openCitation"
        />
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
            <IconButton :icon="XMarkIcon" label="remove pin" variant="plain" size="sm" @click="removePin(project.id, p.path)" />
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
            <div class="flex items-center gap-1">
              <button
                v-for="m in MODES"
                :key="m"
                class="rounded px-1.5 py-0.5 text-2xs transition-colors"
                :class="chatOptions.mode === m ? 'bg-accent/10 text-accent' : 'text-subtle hover:text-fg'"
                :title="m === 'ask' ? 'Read-only — no file edits' : m === 'plan' ? 'Produces a plan, no edits' : m === 'multi-task' ? 'Decomposes into sub-tasks' : 'Agentic — full tools'"
                @click="chatOptions.mode = m"
              >{{ m }}</button>
            </div>
            <Button v-if="streaming" variant="secondary" :disabled="stopping" @click="stop">
              <StopIcon class="size-4" /> {{ stopping ? 'stopping…' : 'stop' }}
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
    </template>
  </div>
</template>
