import type { Plan, PlanStep, PostValidationResult, ValidationResult } from './types'

/**
 * Recovering structured output from a chat model.
 *
 * The naive approach — `/\{[\s\S]*\}/` — spans from the first `{` to the *last*
 * `}` in the response, so one stray brace in the model's preamble swallows the
 * real object and the parse fails. That failure is not loud: it degrades to a
 * low confidence score, which falls under the approval threshold, which aborts
 * the whole run. So the scanner below tracks brace depth (respecting strings and
 * escapes) and tries each balanced candidate in turn.
 *
 * Ollama's `format: "json"` makes this rare, but not never: it is unsupported by
 * some models and ignored by others.
 */

/** True when the text contains a `{` outside of nothing — i.e. it *tried* JSON. */
function looksLikeJson(text: string): boolean {
  return text.includes('{')
}

/**
 * First balanced `{…}` in `text` that parses as JSON, or `null`.
 *
 * Scans rather than regexes so nested objects, braces inside strings, and
 * escaped quotes all behave.
 */
export function extractJsonObject(text: string): unknown | null {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
      const ch = text[i]

      if (escaped) {
        escaped = false
        continue
      }
      if (inString && ch === '\\') {
        // Escapes only exist inside strings. Honouring one outside a string
        // would let a stray `\{` suppress a depth increment, so the outer
        // candidate fails to balance and we return a *nested* object instead of
        // null — silently wrong rather than visibly absent.
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue

      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1))
          } catch {
            // Balanced but not valid JSON (trailing comma, unquoted key, …).
            // Fall through to the next `{`.
          }
          break
        }
      }
    }
  }
  return null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Parse a planner response. A model that answers in prose still produces a
 * usable plan — its text becomes the summary with no steps, which the caller
 * surfaces rather than treating as an error.
 */
export function parsePlan(raw: string): Plan {
  const parsed = extractJsonObject(raw) as Partial<Plan> | null
  if (!parsed || typeof parsed !== 'object') {
    return { plan: raw.trim(), steps: [], assumptions: [] }
  }

  const steps: PlanStep[] = (Array.isArray(parsed.steps) ? parsed.steps : []).map(
    (step, i): PlanStep => {
      const s = (step ?? {}) as Partial<PlanStep>
      return {
        id: typeof s.id === 'string' && s.id.trim() ? s.id : `step_${i + 1}`,
        goal: typeof s.goal === 'string' ? s.goal : '',
        files: asStringArray(s.files),
        risks: asStringArray(s.risks),
        constraints: asStringArray(s.constraints),
        status: 'pending',
      }
    },
  )

  return {
    plan: typeof parsed.plan === 'string' ? parsed.plan : raw.trim(),
    steps,
    assumptions: asStringArray(parsed.assumptions),
  }
}

/**
 * Parse a validator response.
 *
 * `approved` is always `false` here — the orchestrator decides approval from the
 * score and the configured threshold. A validator asked to grade its own verdict
 * reliably declines to approve anything.
 *
 * The two failure confidences are deliberately different: prose (no JSON at all)
 * scores 0.5 because the model may simply have answered conversationally, while
 * malformed JSON scores 0.3 because a model that tried and failed to follow the
 * schema is less trustworthy about the rest of its output.
 */
export function parseValidation(raw: string): ValidationResult {
  const parsed = extractJsonObject(raw) as Record<string, unknown> | null

  if (!parsed || typeof parsed !== 'object') {
    return {
      issues: looksLikeJson(raw) ? ['Failed to parse validation response'] : [],
      missingCases: [],
      conflicts: [],
      confidenceScore: looksLikeJson(raw) ? 0.3 : 0.5,
      approved: false,
      raw,
    }
  }

  const score = parsed.confidenceScore ?? parsed.confidence_score
  return {
    issues: asStringArray(parsed.issues),
    missingCases: asStringArray(parsed.missingCases ?? parsed.missing_cases),
    conflicts: asStringArray(parsed.conflicts),
    confidenceScore: typeof score === 'number' ? clamp01(score) : 0.5,
    approved: false,
    raw,
  }
}

/**
 * Parse a post-validator response.
 *
 * **Fails closed.** Upstream returned `approved: true` when it couldn't parse the
 * reviewer, so an unreadable review silently became a green check — precisely
 * backwards for the one component whose job is catching bad work.
 */
export function parsePostValidation(raw: string): PostValidationResult {
  const parsed = extractJsonObject(raw) as Record<string, unknown> | null

  if (!parsed || typeof parsed !== 'object') {
    return {
      approved: false,
      issues: ['Post-validation response could not be parsed'],
      suggestedFixes: [],
    }
  }

  return {
    approved: parsed.approved === true,
    issues: asStringArray(parsed.issues),
    suggestedFixes: asStringArray(parsed.suggestedFixes ?? parsed.suggested_fixes),
  }
}
