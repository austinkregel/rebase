<script setup lang="ts">
import { DocumentTextIcon } from '@heroicons/vue/20/solid'
import type { Citation } from '@/services/crucibleState'
import type { ApprovalDecision } from '@/services/crucibleChat'
import MarkdownText from './MarkdownText.vue'
import ToolCallRow from './ToolCallRow.vue'
import { basename, type GroupedTurn } from './transcript'

// One turn: the prose, whatever tools it invoked, and the code it cited.
//
// The weight rules come from ./transcript.ts. Note the de-emphasis of process
// turns comes from NOT being carded, not from graying the text — the agent's
// narration still has to be readable.
defineProps<{ turn: GroupedTurn }>()

const emit = defineEmits<{
  approve: [callId: string, decision: ApprovalDecision]
  openCitation: [citation: Citation]
}>()
</script>

<template>
  <div :class="turn.showLabel ? 'mb-3' : 'mb-1.5'">
    <!-- System note (e.g. an allowlist grant, or a stop) -->
    <p v-if="turn.role === 'system'" class="rounded bg-elevated px-2 py-1 text-2xs italic text-subtle">
      {{ turn.text }}
    </p>

    <template v-else>
      <span v-if="turn.showLabel" class="mb-0.5 block text-2xs uppercase tracking-[0.1em] text-subtle">
        {{ turn.role === 'user' ? 'you' : 'crucible' }}
      </span>

      <div
        v-if="turn.text || turn.streaming"
        class="break-words rounded px-2 py-1.5 text-sm text-fg"
        :class="turn.role === 'user' || turn.isAnswer ? 'bg-elevated' : ''"
      >
        <!-- User input is plain text; model output is rendered (and sanitized) markdown. -->
        <span v-if="turn.role === 'user'" class="whitespace-pre-wrap">{{ turn.text }}</span>
        <MarkdownText v-else :text="turn.text" />
        <span v-if="turn.streaming" class="animate-pulse">▋</span>
      </div>

      <p v-if="turn.error" class="mt-1 px-2 text-xs text-red">{{ turn.error }}</p>

      <div v-if="turn.toolCalls?.length" class="mt-1 flex flex-col gap-0.5">
        <ToolCallRow
          v-for="tc in turn.toolCalls"
          :key="tc.id"
          :call="tc"
          @approve="(id, decision) => emit('approve', id, decision)"
        />
      </div>

      <div v-if="turn.citations?.length" class="mt-1 flex flex-wrap gap-1 px-1">
        <button
          v-for="(c, i) in turn.citations"
          :key="i"
          class="flex max-w-full items-center gap-1 rounded border border-line bg-elevated px-1.5 py-0.5 text-2xs text-subtle hover:border-accent hover:text-fg"
          :title="`${c.relative}:${c.lineStart}`"
          @click="emit('openCitation', c)"
        >
          <DocumentTextIcon class="size-3 shrink-0" />
          <span class="overflow-hidden text-ellipsis whitespace-nowrap">
            {{ basename(c.relative) }}:{{ c.lineStart }}
          </span>
        </button>
      </div>
    </template>
  </div>
</template>
