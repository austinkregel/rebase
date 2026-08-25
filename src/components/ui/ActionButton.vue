<script setup lang="ts">
import { computed, ref, type FunctionalComponent } from 'vue'
import { CheckIcon, ArrowPathIcon } from '@heroicons/vue/20/solid'
import Button from './Button.vue'
import Spinner from './Spinner.vue'
import { conjugate, type ActionLabels } from '@/services/conjugate'

// A state-aware action button. Give it a verb — "Save", "Build index" — and it
// moves the label through tenses as the work runs: Save → Saving… → Saved, with
// a standardized spinner in flight, a minimum in-flight duration so fast work
// doesn't flicker, a brief success hold, and a sticky click-to-retry error.
//
// Two ways to drive it:
//   • Uncontrolled (default): pass :action returning a Promise. The button owns
//     the whole lifecycle and the timing.
//   • Controlled: pass :state from an existing state machine (session.phase,
//     crucible IndexPhase). The button becomes a display mirror and emits
//     `trigger`/`retry` on click for the caller to act on.
type ActionState = 'idle' | 'pending' | 'success' | 'error'

const props = withDefaults(
  defineProps<{
    /** Base verb label; the button conjugates it into the other states. */
    label: string
    /**
     * Override any derived non-idle state string (e.g. { success: 'Index built' }).
     * The idle label always comes from `label`, so the resting and in-flight
     * grammar can't drift apart.
     */
    states?: Partial<Omit<ActionLabels, 'idle'>>
    /** Uncontrolled mode: the async work. Its resolution drives the states. */
    action?: () => Promise<unknown>
    /** Controlled mode: state supplied by an external machine. */
    state?: ActionState
    /** Controlled mode: replace the pending label for a specific phase. */
    phaseLabel?: string
    /** Optional leading icon shown only in the idle state. */
    icon?: FunctionalComponent
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    block?: boolean
    type?: 'button' | 'submit'
    /** Genuine unavailability — distinct from being in-flight. */
    disabled?: boolean
    /** Floor on how long the pending state shows, so fast work still reads. */
    minPendingMs?: number
    /** How long "Saved" lingers before settling back to idle; 0 disables it. */
    successHoldMs?: number
  }>(),
  {
    variant: 'primary',
    size: 'sm',
    type: 'button',
    disabled: false,
    minPendingMs: 400,
    successHoldMs: 1200,
  },
)

const emit = defineEmits<{
  trigger: []
  retry: []
  success: [result: unknown]
  error: [err: unknown]
  settle: []
}>()

const controlled = computed(() => props.state !== undefined)
const internal = ref<ActionState>('idle')
const current = computed<ActionState>(() => (controlled.value ? props.state! : internal.value))

const labels = computed(() => conjugate(props.label, props.states))
const displayLabel = computed(() => {
  switch (current.value) {
    case 'pending':
      return controlled.value && props.phaseLabel ? props.phaseLabel : labels.value.pending
    case 'success':
      return labels.value.success
    case 'error':
      return labels.value.error
    default:
      return labels.value.idle
  }
})

// Error borrows the danger chrome regardless of the resting variant, so a
// failure reads the same everywhere.
const effectiveVariant = computed(() =>
  current.value === 'error' ? 'danger' : props.variant,
)
// Interactive only while idle (start) or error (retry) — never mid-flight or
// during the success hold.
const interactive = computed(
  () => !props.disabled && (current.value === 'idle' || current.value === 'error'),
)

// Icons step up with the control size, matching Button/IconButton convention.
const iconSizeClass = computed(() => (props.size === 'md' ? 'size-4' : 'size-3.5'))
const spinnerSize = computed(() => (props.size === 'md' ? 'md' : 'sm'))

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Guards against a stale timer reverting a state the user has since re-triggered.
let generation = 0

async function run() {
  if (!props.action) return
  const gen = ++generation
  internal.value = 'pending'
  const started = Date.now()
  try {
    const result = await props.action()
    await holdMinimum(started)
    if (gen !== generation) return
    internal.value = 'success'
    emit('success', result)
    if (props.successHoldMs > 0) await delay(props.successHoldMs)
    if (gen !== generation) return
    internal.value = 'idle'
    emit('settle')
  } catch (err) {
    await holdMinimum(started)
    if (gen !== generation) return
    internal.value = 'error'
    emit('error', err)
  }
}

async function holdMinimum(started: number) {
  const remaining = props.minPendingMs - (Date.now() - started)
  if (remaining > 0) await delay(remaining)
}

function onClick() {
  if (!interactive.value) return
  if (current.value === 'error') {
    emit('retry')
    if (!controlled.value) run()
    return
  }
  emit('trigger')
  if (!controlled.value) run()
}
</script>

<template>
  <Button
    :variant="effectiveVariant"
    :size="size"
    :block="block"
    :type="type"
    :disabled="disabled"
    :aria-busy="current === 'pending'"
    :aria-disabled="!interactive || undefined"
    :class="{ 'cursor-default': !interactive && !disabled }"
    @click="onClick"
  >
    <Spinner v-if="current === 'pending'" :size="spinnerSize" decorative />
    <component :is="CheckIcon" v-else-if="current === 'success'" :class="iconSizeClass" />
    <component :is="ArrowPathIcon" v-else-if="current === 'error'" :class="iconSizeClass" />
    <component :is="icon" v-else-if="icon" :class="iconSizeClass" />
    <span aria-live="polite">{{ displayLabel }}</span>
  </Button>
</template>
