<script setup lang="ts">
import { ArrowPathIcon } from '@heroicons/vue/20/solid'
import Button from '@/components/ui/Button.vue'
import type { ToolInvocation } from '@/services/crucibleState'
import type { ApprovalDecision } from '@/services/crucibleChat'
import { diffTone, isMutating, toolIcon, toolTone } from './transcript'

// One tool invocation, in one of three presentations (see ./transcript.ts for
// the rule these follow):
//
//   attention   awaiting / error / denied — the only bordered, tinted rows left
//               in the transcript, because they're the only ones needing a decision
//   disclosure  finished work that produced output or a diff, hidden behind <details>
//   quiet       running, or finished with nothing to show
//
// Within the quiet and disclosure forms, mutating tools stay full-contrast so the
// user can read what the agent changed; read-only ones recede.
defineProps<{ call: ToolInvocation }>()

const emit = defineEmits<{ approve: [callId: string, decision: ApprovalDecision] }>()
</script>

<template>
  <!-- Attention: a pending approval, a failure, or a denial. -->
  <div
    v-if="call.status === 'awaiting' || call.status === 'error' || call.status === 'denied'"
    class="rounded border px-2 py-1 text-2xs"
    :class="call.status === 'awaiting' ? 'border-accent/40 bg-accent/5' : 'border-red/40 bg-red/5'"
  >
    <div class="flex items-center gap-1.5">
      <component :is="toolIcon(call.status)" class="size-3.5 shrink-0" :class="toolTone(call.status)" />
      <span class="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-fg">{{ call.summary }}</span>
    </div>

    <pre
      v-if="call.diff"
      class="mt-1 max-h-48 overflow-auto rounded bg-bg p-1 font-mono text-2xs leading-snug"
    ><span v-for="(ln, i) in call.diff.split('\n')" :key="i" class="block" :class="diffTone(ln)">{{ ln }}</span></pre>

    <p v-if="call.error" class="mt-0.5 break-words text-xs text-red">{{ call.error }}</p>

    <div v-if="call.status === 'awaiting'" class="mt-1.5 flex flex-wrap gap-1">
      <Button variant="primary" size="sm" @click="emit('approve', call.id, 'allow')">Allow</Button>
      <Button variant="secondary" size="sm" @click="emit('approve', call.id, 'always')">
        Allow &amp; remember
      </Button>
      <Button variant="danger" size="sm" @click="emit('approve', call.id, 'deny')">Deny</Button>
    </div>
  </div>

  <!-- Disclosure: finished work with output or a diff to inspect. -->
  <details
    v-else-if="call.diff || call.output"
    class="px-1 py-0.5"
    :class="isMutating(call.name) ? 'text-xs text-fg' : 'text-2xs text-subtle'"
  >
    <summary class="cursor-pointer truncate hover:text-fg">{{ call.summary }}</summary>
    <pre
      v-if="call.diff"
      class="mt-1 max-h-48 overflow-auto rounded bg-bg p-1 font-mono text-2xs leading-snug"
    ><span v-for="(ln, i) in call.diff.split('\n')" :key="i" class="block" :class="diffTone(ln)">{{ ln }}</span></pre>
    <pre
      v-else
      class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-bg p-1 text-2xs text-subtle"
    >{{ call.output }}</pre>
  </details>

  <!-- Quiet: in flight, or done with nothing to show. -->
  <div
    v-else
    class="flex items-center gap-1.5 px-1 py-0.5"
    :class="isMutating(call.name) ? 'text-xs text-fg' : 'text-2xs text-subtle'"
  >
    <ArrowPathIcon v-if="call.status === 'running'" class="size-3 shrink-0 animate-spin text-accent" />
    <span class="overflow-hidden text-ellipsis whitespace-nowrap">{{ call.summary }}</span>
  </div>
</template>
