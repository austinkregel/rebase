import { describe, expect, it } from 'vitest'
import { extractJsonObject, parsePlan, parsePostValidation, parseValidation } from './json'

describe('extractJsonObject', () => {
  it('finds the object after a preamble', () => {
    expect(extractJsonObject('Sure! Here is the plan:\n{"plan":"x"}')).toEqual({ plan: 'x' })
  })

  it('finds the object inside a fenced code block', () => {
    expect(extractJsonObject('```json\n{"plan":"x"}\n```')).toEqual({ plan: 'x' })
  })

  it('keeps nested objects and arrays intact', () => {
    const text = '{"a":{"b":[1,{"c":2}]},"d":3}'
    expect(extractJsonObject(text)).toEqual({ a: { b: [1, { c: 2 }] }, d: 3 })
  })

  it('ignores braces inside strings', () => {
    expect(extractJsonObject('{"goal":"replace { with }"}')).toEqual({ goal: 'replace { with }' })
  })

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"goal":"say \\"hi\\" politely"}')).toEqual({
      goal: 'say "hi" politely',
    })
  })

  it('skips a stray brace in prose and finds the real object', () => {
    // The regression this whole scanner exists for: a greedy first-{ to last-}
    // match spans both and parses as nothing.
    const text = 'The handler uses { as a delimiter.\nHere it is:\n{"confidence_score":0.9}'
    expect(extractJsonObject(text)).toEqual({ confidence_score: 0.9 })
  })

  it('returns null when nothing balanced parses', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{"unterminated": ')).toBeNull()
    expect(extractJsonObject('{trailing, comma,}')).toBeNull()
  })
})

describe('parsePlan', () => {
  it('parses steps and defaults missing ids positionally', () => {
    const plan = parsePlan(
      JSON.stringify({
        plan: 'Add caching',
        steps: [
          { id: 'a', goal: 'first', files: ['x.ts'], risks: ['r'], constraints: ['c'] },
          { goal: 'second' },
        ],
        assumptions: ['node 22'],
      }),
    )

    expect(plan.plan).toBe('Add caching')
    expect(plan.steps.map((s) => s.id)).toEqual(['a', 'step_2'])
    expect(plan.steps[0]).toMatchObject({ files: ['x.ts'], risks: ['r'], status: 'pending' })
    expect(plan.steps[1]).toMatchObject({ files: [], risks: [], constraints: [] })
    expect(plan.assumptions).toEqual(['node 22'])
  })

  it('falls back to the raw text as the summary when the model answers in prose', () => {
    const plan = parsePlan('  I would start by reading the router.  ')
    expect(plan).toEqual({
      plan: 'I would start by reading the router.',
      steps: [],
      assumptions: [],
    })
  })

  it('drops non-string entries rather than propagating them', () => {
    const plan = parsePlan(JSON.stringify({ plan: 'x', steps: [], assumptions: ['ok', 3, null] }))
    expect(plan.assumptions).toEqual(['ok'])
  })
})

describe('parseValidation', () => {
  it('accepts both snake_case and camelCase keys', () => {
    const snake = parseValidation(
      JSON.stringify({ issues: ['i'], missing_cases: ['m'], conflicts: [], confidence_score: 0.82 }),
    )
    expect(snake).toMatchObject({ issues: ['i'], missingCases: ['m'], confidenceScore: 0.82 })

    const camel = parseValidation(JSON.stringify({ missingCases: ['m'], confidenceScore: 0.82 }))
    expect(camel).toMatchObject({ missingCases: ['m'], confidenceScore: 0.82 })
  })

  it('clamps the score into 0..1', () => {
    expect(parseValidation('{"confidence_score": 3}').confidenceScore).toBe(1)
    expect(parseValidation('{"confidence_score": -2}').confidenceScore).toBe(0)
    expect(parseValidation('{"confidence_score": "high"}').confidenceScore).toBe(0.5)
  })

  it('never approves — that is the orchestrator’s call', () => {
    expect(parseValidation('{"approved": true, "confidence_score": 1}').approved).toBe(false)
  })

  it('scores prose at 0.5 and malformed JSON at 0.3', () => {
    // Prose may just be a conversational answer; a botched schema is a worse signal.
    const prose = parseValidation('The plan looks reasonable to me.')
    expect(prose.confidenceScore).toBe(0.5)
    expect(prose.issues).toEqual([])

    const malformed = parseValidation('{"confidence_score": 0.9,}')
    expect(malformed.confidenceScore).toBe(0.3)
    expect(malformed.issues).toEqual(['Failed to parse validation response'])
  })
})

describe('parsePostValidation', () => {
  it('parses an approval', () => {
    expect(parsePostValidation('{"approved": true, "issues": [], "suggested_fixes": ["f"]}')).toEqual(
      { approved: true, issues: [], suggestedFixes: ['f'] },
    )
  })

  it('fails closed on an unparseable review', () => {
    // Upstream returned approved:true here, turning an unreadable reviewer into
    // a green check.
    const result = parsePostValidation('I was unable to complete the review.')
    expect(result.approved).toBe(false)
    expect(result.issues).toEqual(['Post-validation response could not be parsed'])
  })

  it('treats a non-boolean approved as not approved', () => {
    expect(parsePostValidation('{"approved": "yes"}').approved).toBe(false)
  })
})
