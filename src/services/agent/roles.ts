import type { ModelRole } from './types'

/**
 * Per-role sampling temperature.
 *
 * The spread is the point: a planner benefits from some divergence, an executor
 * writing a patch does not. These are the values the pipeline was tuned against
 * upstream — change them deliberately, not incidentally.
 */
export const ROLE_TEMPERATURES: Record<ModelRole, number> = {
  planner: 0.3,
  validator: 0.2,
  executor: 0.1,
  postValidator: 0.2,
}

/** Roles that must answer with a single JSON object (Ollama `format: "json"`). */
export const JSON_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>([
  'planner',
  'validator',
  'postValidator',
])

/**
 * Resolve a role to a concrete Ollama model, falling back to the general chat
 * model. Blank is the *normal* configuration, not an error state — someone with
 * one local model shouldn't have to name it four times.
 */
export function resolveRoleModel(
  roles: Partial<Record<ModelRole, string>> | undefined,
  role: ModelRole,
  fallback: string,
): string {
  const configured = roles?.[role]?.trim()
  return configured || fallback
}
