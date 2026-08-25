import nlp from 'compromise'

// The four grammatical states an action label moves through. `ActionButton`
// renders one of these depending on where the async work is.
export interface ActionLabels {
  /** Resting label — the verb in its base form, e.g. "Save". */
  idle: string
  /** In-flight label — present participle, e.g. "Saving…". */
  pending: string
  /** Post-success label — past tense, e.g. "Saved". */
  success: string
  /** Failure label, e.g. "Save failed". */
  error: string
}

// Derived labels are pure functions of the input string, and labels are almost
// always static author-time strings, so memoize to avoid re-running the tagger.
const cache = new Map<string, ActionLabels>()

/**
 * Derive the four states of an action label from its verb using compromise's
 * morphology, so irregulars are correct ("Build" → "Built", "Run" → "Ran").
 * Only the verb token is conjugated; the rest of the phrase keeps its order, so
 * "Build index" → "Building index…" / "Built index". When the default word
 * order isn't what you want (e.g. you'd rather say "Index built"), pass an
 * `overrides` entry for that state — every field is overridable.
 */
export function conjugate(label: string, overrides: Partial<ActionLabels> = {}): ActionLabels {
  const idle = label.trim()
  let base = cache.get(idle)
  if (!base) {
    base = derive(idle)
    cache.set(idle, base)
  }
  return { ...base, ...overrides }
}

// compromise's base View type doesn't surface .conjugate(); it lives on the
// verbs subview. Narrow to just the forms we read.
type VerbForms = Partial<Record<'Gerund' | 'PastTense', string>>
interface Conjugable {
  conjugate(): VerbForms[]
}

function derive(idle: string): ActionLabels {
  const words = idle.split(/\s+/)
  const verbs = nlp(idle).verbs()
  const verb = verbs.found ? verbs.first().text() : ''
  const forms = verb
    ? (verbs.first() as unknown as Conjugable).conjugate()[0]
    : undefined

  // Fall back to the untouched label when there's no verb to conjugate (a
  // noun-only label like "Details") rather than guessing.
  const pending = forms?.Gerund ? replaceVerb(words, verb, forms.Gerund) : idle
  const success = forms?.PastTense ? replaceVerb(words, verb, forms.PastTense) : idle

  return {
    idle,
    pending: `${pending}…`,
    success,
    error: `${idle} failed`,
  }
}

// Swap the first word matching `verb` for its conjugated form, preserving the
// verb's original capitalization and the position of every other word.
function replaceVerb(words: string[], verb: string, form: string): string {
  const out = words.slice()
  const i = out.findIndex((w) => w.toLowerCase() === verb.toLowerCase())
  if (i !== -1) out[i] = matchCase(out[i], form)
  return out.join(' ')
}

function matchCase(source: string, target: string): string {
  if (!target) return target
  const c = source[0]
  const isUpper = c === c.toUpperCase() && c !== c.toLowerCase()
  return isUpper ? target[0].toUpperCase() + target.slice(1) : target
}
