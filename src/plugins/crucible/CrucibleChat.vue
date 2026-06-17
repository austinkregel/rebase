<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
  DocumentTextIcon,
  SparklesIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ArrowPathIcon,
  ClockIcon,
  PencilSquareIcon,
} from '@heroicons/vue/20/solid'
import { isTauri } from '@/transport/contract'
import { useProjectsStore } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { useFilesStore } from '@/stores/files'
import { useSettingsStore } from '@/stores/settings'
import { ask, stop, isStreaming, chatOptions, resolveToolApproval, loadConversations, activateConversation, newConversation, type ApprovalDecision, type ChatMode } from '@/services/crucibleChat'
import { rebuild } from '@/services/crucible'
import { turnsFor, pinsFor, removePin, indexStateFor, conversationListFor, activeConversationIdFor, type Citation, type ToolStatus } from '@/services/crucibleState'
import { READ_ONLY_TOOLS } from '@/services/crucibleTools'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import Button from '@/components/ui/Button.vue'
import IconButton from '@/components/ui/IconButton.vue'
import MarkdownText from './MarkdownText.vue'

const projects = useProjectsStore()
const session = useSessionStore()
const files = useFilesStore()
const settings = useSettingsStore()

const supported = isTauri()
const project = computed(() => projects.active)
const turns = computed(() => (project.value ? turnsFor(project.value.id) : []))

// Annotate each turn for rendering hierarchy.
//
// showLabel  — true only on the first turn of a consecutive same-role run.
//              Collapses the repeated "CRUCIBLE" headers the agent loop produces.
//
// isAnswer   — true on the final assistant turn in a run that carries no
//              toolCalls (it's the prose answer the user asked for).
//              Gets full text-fg weight so it stands out visually.
//
// isProcess  — everything else the agent did to arrive at that answer:
//              narration turns that have toolCalls, or intermediate assistant
//              turns that are followed by more assistant turns.
//              Rendered muted so eyes skip to the answer.
const groupedTurns = computed(() => {
  const ts = turns.value
  return ts.map((t, i) => {
    const showLabel = t.role !== ts[i - 1]?.role
    const nextSameRole = ts[i + 1]?.role === t.role
    // An assistant turn is the "answer" when it's the last in its run and has
    // no tool calls (pure prose reply). Still-streaming final turns also count
    // so the cursor appears at full weight while the answer is being written.
    const isAnswer =
      t.role === 'assistant' && !nextSameRole && !(t.toolCalls?.length)
    const isProcess = t.role === 'assistant' && !isAnswer
    return { ...t, showLabel, isAnswer, isProcess }
  })
})
const pins = computed(() => (project.value ? pinsFor(project.value.id) : []))
const streaming = computed(() => !!project.value && isStreaming(project.value.id))
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
  () =>
    turns.value
      .map((t) => `${t.text.length}|${t.toolCalls?.map((c) => `${c.status}${c.output?.length ?? 0}`).join('') ?? ''}`)
      .join(','),
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function approve(callId: string, decision: ApprovalDecision) {
  resolveToolApproval(callId, decision)
}

// Mutating tools (write/edit/run) change the project and need approval, so the
// user MUST be able to read them — they stay full-contrast even when quiet.
// Read-only tools (read/list/search/grep) can recede into muted whispers.
function isMutating(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name)
}

const TOOL_ICON = {
  running: ArrowPathIcon,
  awaiting: ClockIcon,
  done: CheckCircleIcon,
  denied: ExclamationCircleIcon,
  error: ExclamationCircleIcon,
} as const
function toolIcon(status: ToolStatus) {
  return TOOL_ICON[status]
}
function toolTone(status: ToolStatus): string {
  return status === 'done'
    ? 'text-green'
    : status === 'error' || status === 'denied'
      ? 'text-red'
      : status === 'awaiting'
        ? 'text-yellow'
        : 'text-accent animate-spin'
}
function diffTone(line: string): string {
  if (line.startsWith('+')) return 'text-green'
  if (line.startsWith('-')) return 'text-red'
  if (line.startsWith('@@')) return 'text-accent'
  return 'text-subtle'
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
          <Button v-if="!hasIndex" variant="primary" @click="refresh">Build index</Button>
        </div>

        <div v-for="t in groupedTurns" :key="t.id" :class="t.showLabel ? 'mb-3' : 'mb-1.5'">
          <!-- System note (e.g. allowlist grant) -->
          <p v-if="t.role === 'system'" class="rounded bg-elevated px-2 py-1 text-2xs italic text-subtle">
            {{ t.text }}
          </p>

          <template v-else>
            <!-- Role label: only on first turn of a same-role run -->
            <span v-if="t.showLabel" class="mb-0.5 block text-2xs uppercase tracking-[0.1em] text-subtle">
              {{ t.role === 'user' ? 'you' : 'crucible' }}
            </span>

            <!-- Prose text — the conversation IS the content, so it gets the weight.
                 User:    elevated card.
                 Answer:  elevated card — the agent's actual reply, equally prominent.
                 Process: plain readable text (the agent narrating between tools);
                          de-emphasis comes from NOT being carded, not from graying. -->
            <div
              v-if="t.text || t.streaming"
              class="break-words rounded px-2 py-1.5 text-sm text-fg"
              :class="t.role === 'user' || t.isAnswer ? 'bg-elevated' : ''"
            >
              <!-- User input is plain text; the agent's output is rendered markdown. -->
              <span v-if="t.role === 'user'" class="whitespace-pre-wrap">{{ t.text }}</span>
              <MarkdownText v-else :text="t.text" />
              <span v-if="t.streaming" class="animate-pulse">▋</span>
            </div>

            <p v-if="t.error" class="mt-1 px-2 text-xs text-red">{{ t.error }}</p>

            <!-- Tool calls.
                 Quiet one-liner for done/running/stale reads — just icon + muted label.
                 Bordered card only for states that need attention: awaiting, error, denied,
                 or any tool that has a diff (edit requiring approval). -->
            <div v-if="t.toolCalls?.length" class="mt-1 flex flex-col gap-0.5">
              <template v-for="tc in t.toolCalls" :key="tc.id">
                <!-- Attention card: only states that need the user's eye —
                     a pending approval, a failure, or a denial. These are the
                     only bordered, tinted elements left in the transcript. -->
                <div
                  v-if="tc.status === 'awaiting' || tc.status === 'error' || tc.status === 'denied'"
                  class="rounded border px-2 py-1 text-2xs"
                  :class="
                    tc.status === 'awaiting'
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-red/40 bg-red/5'
                  "
                >
                  <div class="flex items-center gap-1.5">
                    <component :is="toolIcon(tc.status)" class="size-3.5 shrink-0" :class="toolTone(tc.status)" />
                    <span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-fg">{{ tc.summary }}</span>
                  </div>

                  <pre
                    v-if="tc.diff"
                    class="mt-1 max-h-48 overflow-auto rounded bg-bg p-1 font-mono text-2xs leading-snug"
                  ><span v-for="(ln, i) in tc.diff.split('\n')" :key="i" class="block" :class="diffTone(ln)">{{ ln }}</span></pre>

                  <p v-if="tc.error" class="mt-0.5 break-words text-xs text-red">{{ tc.error }}</p>

                  <!-- Approval buttons: primary action is most prominent, deny is danger -->
                  <div v-if="tc.status === 'awaiting'" class="mt-1.5 flex flex-wrap gap-1">
                    <Button variant="primary" size="sm" @click="approve(tc.id, 'allow')">Allow</Button>
                    <Button variant="secondary" size="sm" @click="approve(tc.id, 'always')">Allow &amp; remember</Button>
                    <Button variant="danger" size="sm" @click="approve(tc.id, 'deny')">Deny</Button>
                  </div>
                </div>

                <!-- Quiet, expandable row: finished work (read/search/run/edit).
                     Read-only tools recede to a muted whisper; mutating tools
                     (write/edit/run) stay full-contrast so the user can read what
                     the agent changed. Output/diff hidden behind a disclosure. -->
                <details
                  v-else-if="tc.diff || tc.output"
                  class="px-1 py-0.5"
                  :class="isMutating(tc.name) ? 'text-xs text-fg' : 'text-2xs text-subtle'"
                >
                  <summary class="cursor-pointer truncate hover:text-fg">{{ tc.summary }}</summary>
                  <pre
                    v-if="tc.diff"
                    class="mt-1 max-h-48 overflow-auto rounded bg-bg p-1 font-mono text-2xs leading-snug"
                  ><span v-for="(ln, i) in tc.diff.split('\n')" :key="i" class="block" :class="diffTone(ln)">{{ ln }}</span></pre>
                  <pre
                    v-else
                    class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bg p-1 text-2xs text-subtle"
                  >{{ tc.output }}</pre>
                </details>

                <!-- Plain quiet row: running, or finished with no output. Mutating
                     tools stay full-contrast; read-only ones recede. A small
                     spinner shows only while the tool is in flight. -->
                <div
                  v-else
                  class="flex items-center gap-1.5 px-1 py-0.5"
                  :class="isMutating(tc.name) ? 'text-xs text-fg' : 'text-2xs text-subtle'"
                >
                  <ArrowPathIcon v-if="tc.status === 'running'" class="size-3 shrink-0 animate-spin text-accent" />
                  <span class="overflow-hidden text-ellipsis whitespace-nowrap">{{ tc.summary }}</span>
                </div>
              </template>
            </div>

            <!-- Citations: muted chips, consistent with process de-emphasis -->
            <div v-if="t.citations?.length" class="mt-1 flex flex-wrap gap-1 px-1">
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
    </template>
  </div>
</template>
