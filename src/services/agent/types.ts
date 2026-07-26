/**
 * Shared vocabulary for the Crucible agent pipeline.
 *
 * These shapes are the contract between three layers that must not import each
 * other: the orchestrator produces them, persistence round-trips them, and the
 * UI renders them. Keeping them here (and free of any Vue / Tauri / transport
 * import) is what lets each side be tested on its own.
 */

/** Which model a pipeline phase runs on. */
export type ModelRole = 'planner' | 'validator' | 'executor' | 'postValidator'

/** The four phases of a full `build` run, in order. */
export type AgentPhase = 'planning' | 'validation' | 'execution' | 'postValidation'

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlanStep {
  id: string
  goal: string
  /** Files the step expects to touch — advisory, not enforced. */
  files: string[]
  risks: string[]
  constraints: string[]
  status: PlanStepStatus
  /** Diff or summary of what execution actually did. */
  result?: string
}

export interface Plan {
  /** One-paragraph summary of the whole change. */
  plan: string
  steps: PlanStep[]
  assumptions: string[]
}

export interface ValidationResult {
  issues: string[]
  missingCases: string[]
  conflicts: string[]
  /** 0..1. Clamped on parse — models return everything from -3 to "high". */
  confidenceScore: number
  /**
   * Whether the plan may proceed. Derived by the orchestrator from
   * `confidenceScore >= threshold`, never taken from the model: a validator asked
   * to grade its own verdict always says no.
   */
  approved: boolean
  /** Raw model text, kept for display when parsing degraded. */
  raw?: string
}

export interface ExecutionResult {
  stepId: string
  success: boolean
  diff?: string
  error?: string
  filesChanged: string[]
}

export interface PostValidationResult {
  approved: boolean
  issues: string[]
  suggestedFixes: string[]
}

/**
 * Everything the pipeline can report. The UI reduces these into `crucibleState`;
 * no component subscribes to them directly.
 */
export type AgentEvent =
  | { type: 'phaseStarted'; phase: AgentPhase }
  | { type: 'planGenerated'; plan: Plan }
  | { type: 'validationComplete'; validation: ValidationResult }
  | { type: 'planRefined'; plan: Plan; iteration: number }
  | { type: 'planComplete'; plan: Plan; validation?: ValidationResult; approved: boolean }
  | { type: 'stepStarted'; stepId: string; step: PlanStep }
  | { type: 'stepCompleted'; result: ExecutionResult }
  | { type: 'stepFailed'; result: ExecutionResult }
  | { type: 'toolCallStarted'; tool: string; args: Record<string, unknown>; agent?: string }
  | { type: 'toolCallCompleted'; tool: string; output: string; durationMs: number; agent?: string }
  | { type: 'toolCallFailed'; tool: string; error: string; durationMs?: number; agent?: string }
  | { type: 'postValidationComplete'; result: PostValidationResult }
  | { type: 'streamToken'; role: ModelRole | 'subagent'; token: string; stepId?: string; agent?: string }
  | { type: 'error'; message: string }
  | { type: 'complete'; plan?: Plan; results: ExecutionResult[] }

export type AgentEventSink = (event: AgentEvent) => void
