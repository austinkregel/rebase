import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
} from '@heroicons/vue/20/solid'
import { READ_ONLY_TOOLS } from '@/services/crucibleTools'
import type { ChatTurn, ToolStatus } from '@/services/crucibleState'

/**
 * Presentation rules for the chat transcript.
 *
 * Extracted from the panel so they can be tested — the grouping heuristic below
 * is the subtlest logic in the whole feature and had no coverage inline.
 *
 * The transcript has exactly **two contrast levels and one attention level**:
 *
 *   carded (`bg-elevated`)  the user's input and the agent's answer — the content
 *   plain                   process narration and quiet tool rows — skim this
 *   bordered + tinted       awaiting / error / denied — act on this
 *
 * Every element must pick one of those three. Adding a fourth weight is how a
 * dense panel turns into noise, so new surfaces get assigned to an existing
 * level or move out of the column entirely.
 */

/**
 * A turn annotated with its rendering role.
 *
 * There is deliberately no `isProcess` flag: "process" is just an assistant turn
 * that isn't the answer, so a second field would only be a copy of `!isAnswer`
 * that could drift out of sync with it.
 */
export interface GroupedTurn extends ChatTurn {
  /** First turn of a run of the same role — the only one that shows a label. */
  showLabel: boolean
  /** The prose reply the user asked for. Gets full weight. */
  isAnswer: boolean
}

/**
 * Annotate turns for rendering.
 *
 * `showLabel` collapses the repeated "CRUCIBLE" headers the agent loop produces.
 * `isAnswer` is the last assistant turn of a run that carries no tool calls —
 * a still-streaming final turn counts, so the answer reads at full weight while
 * it is being written rather than snapping into place at the end.
 */
export function groupTurns(turns: readonly ChatTurn[]): GroupedTurn[] {
  return turns.map((t, i) => {
    const showLabel = t.role !== turns[i - 1]?.role
    const nextSameRole = turns[i + 1]?.role === t.role
    const isAnswer = t.role === 'assistant' && !nextSameRole && !t.toolCalls?.length
    return { ...t, showLabel, isAnswer }
  })
}

/**
 * A cheap fingerprint of everything that should trigger an auto-scroll: streamed
 * text growing, and tool calls changing status or gaining output.
 *
 * Watching the array identity alone would miss all of it, since turns are mutated
 * in place.
 */
export function activityKey(turns: readonly ChatTurn[]): string {
  return turns
    .map((t) => {
      const calls = t.toolCalls?.map((c) => `${c.status}${c.output?.length ?? 0}`).join('') ?? ''
      return `${t.text.length}|${calls}`
    })
    .join(',')
}

/**
 * Mutating tools change the project and need approval, so the user must be able
 * to read them — they stay full-contrast even when quiet. Read-only tools
 * (read/list/search/grep) can recede into muted whispers.
 */
export function isMutating(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name)
}

const TOOL_ICON = {
  running: ArrowPathIcon,
  awaiting: ClockIcon,
  done: CheckCircleIcon,
  denied: ExclamationCircleIcon,
  error: ExclamationCircleIcon,
} as const

export function toolIcon(status: ToolStatus) {
  return TOOL_ICON[status]
}

export function toolTone(status: ToolStatus): string {
  return status === 'done'
    ? 'text-green'
    : status === 'error' || status === 'denied'
      ? 'text-red'
      : status === 'awaiting'
        ? 'text-yellow'
        : 'text-accent animate-spin'
}

/** Colour one line of a unified diff. */
export function diffTone(line: string): string {
  if (line.startsWith('+')) return 'text-green'
  if (line.startsWith('-')) return 'text-red'
  if (line.startsWith('@@')) return 'text-accent'
  return 'text-subtle'
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
