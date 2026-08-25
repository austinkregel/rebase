import { defineStore } from 'pinia'
import { defaultEditorSettings, type EditorSettings } from '@/cm/setup'
import { loadValue, saveValue } from '@/services/store'
import { resolveRoleModel } from '@/services/agent/roles'
import type { ModelRole } from '@/services/agent/types'
import {
  applyAppearance,
  defaultAppearance,
  type AppearanceSettings,
} from '@/services/appearance'

export interface IndexingSettings {
  /** Ollama endpoint used for both embeddings and Crucible chat. */
  ollamaUrl: string
  /** Embedding model the index is built + queried with. */
  embedModel: string
  /** Chat model Crucible streams answers from (Ollama). */
  chatModel: string
  /**
   * Commands the Crucible AGENT (the LLM) may use via its `run_command` tool —
   * an independent, narrower allowlist than the operator's exec allowlist, so
   * the model can't even attempt commands it shouldn't. Prefix-matched; empty
   * means the agent can run nothing. The agent's own exec allowlist still applies.
   */
  agentCommands: string[]
  /**
   * Commands the agent may NEVER run, refused before a prompt is even shown
   * (Claude Code's deny rules — deny wins over allow). Prefix-matched like
   * `agentCommands`; empty means nothing is force-denied. There is no default
   * denylist: a cwd doesn't sandbox a shell, so this is the operator's lever for
   * the handful of commands they want hard-blocked regardless of approval.
   */
  agentCommandsDeny: string[]
  /**
   * Ceiling on the context window Crucible requests from Ollama, in tokens.
   * 0 uses the built-in cap (`MAX_NUM_CTX`). Raise it if you have the memory —
   * Ollama sizes the KV cache from this, so it is the difference between a
   * model that fits on the GPU and one that offloads to CPU. An explicit
   * modelfile `num_ctx` always wins over this.
   */
  numCtxMax: number
}

const defaultIndexing: IndexingSettings = {
  ollamaUrl: 'http://localhost:11434',
  embedModel: 'nomic-embed-text',
  chatModel: 'qwen2.5-coder',
  agentCommands: ['git status', 'git diff', 'git log', 'ls', 'cat', 'rg', 'grep', 'go test', 'npm test', 'cargo test'],
  agentCommandsDeny: [],
  numCtxMax: 0,
}

export interface AdversarialSettings {
  /** Minimum validator confidence (0..1) before a plan may be executed. */
  confidenceThreshold: number
  /** How many validate → refine rounds to attempt before giving up. */
  maxIterations: number
  /** Review the result against the plan after execution. */
  postValidation: boolean
}

export interface AgentSettings {
  /**
   * Per-role Ollama model. Blank inherits `indexing.chatModel` — the common case,
   * since most people run a single local model; the split exists so a large model
   * can plan while a fast one executes.
   */
  roleModels: Record<ModelRole, string>
  adversarial: AdversarialSettings
  /**
   * Commands the agent may never run.
   *
   * **Not enforced yet** — the matcher lands with the executor's tool policy.
   * Until then this is stored configuration only; the operative controls are
   * `indexing.agentCommands` (checked before a request leaves) and the agent's
   * own server-side exec allowlist.
   */
  commandBlocklist: string[]
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

const defaultAgent: AgentSettings = {
  roleModels: { planner: '', validator: '', executor: '', postValidator: '' },
  adversarial: { confidenceThreshold: 0.7, maxIterations: 3, postValidation: true },
  commandBlocklist: ['rm -rf /', 'mkfs', 'shutdown', 'reboot', 'dd if=', ':(){:|:&};:'],
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    editor: { ...defaultEditorSettings } as EditorSettings,
    indexing: { ...defaultIndexing } as IndexingSettings,
    appearance: { ...defaultAppearance } as AppearanceSettings,
    agent: structuredClone(defaultAgent) as AgentSettings,
    loaded: false,
  }),

  actions: {
    async load() {
      const editor = await loadValue<Partial<EditorSettings>>('editorSettings', {})
      const indexing = await loadValue<Partial<IndexingSettings>>('indexingSettings', {})
      const appearance = await loadValue<Partial<AppearanceSettings>>('appearanceSettings', {})
      const agent = await loadValue<Partial<AgentSettings>>('agentSettings', {})
      this.editor = { ...defaultEditorSettings, ...editor }
      this.indexing = { ...defaultIndexing, ...indexing }
      this.appearance = { ...defaultAppearance, ...appearance }
      // Nested groups merge one level down, so a stored config written before a
      // field existed still picks up that field's default.
      this.agent = {
        ...defaultAgent,
        ...agent,
        roleModels: { ...defaultAgent.roleModels, ...agent.roleModels },
        adversarial: { ...defaultAgent.adversarial, ...agent.adversarial },
        // Union rather than replace: a deny-list must only grow. Plain spread
        // would freeze a user's list at whatever shipped when they first saved,
        // so entries added in a later release would never reach them. Also
        // avoids aliasing `defaultAgent`'s array into reactive state.
        commandBlocklist: [
          ...new Set([...defaultAgent.commandBlocklist, ...(agent.commandBlocklist ?? [])]),
        ],
      }
      applyAppearance(this.appearance)
      this.loaded = true
    },

    async updateAppearance(patch: Partial<AppearanceSettings>) {
      this.appearance = { ...this.appearance, ...patch }
      applyAppearance(this.appearance)
      await saveValue('appearanceSettings', this.appearance)
    },

    async update(patch: Partial<EditorSettings>) {
      this.editor = { ...this.editor, ...patch }
      await saveValue('editorSettings', this.editor)
    },

    async updateIndexing(patch: Partial<IndexingSettings>) {
      this.indexing = { ...this.indexing, ...patch }
      await saveValue('indexingSettings', this.indexing)
    },

    /**
     * Patch agent settings. Nested groups accept partials — callers routinely
     * set one role or one threshold, and typing this as `Partial<AgentSettings>`
     * would force every call site to cast a one-key object to a full record.
     */
    async updateAgent(patch: {
      roleModels?: Partial<Record<ModelRole, string>>
      adversarial?: Partial<AdversarialSettings>
      commandBlocklist?: string[]
    }) {
      const adversarial = { ...this.agent.adversarial, ...patch.adversarial }
      this.agent = {
        ...this.agent,
        ...patch,
        roleModels: { ...this.agent.roleModels, ...patch.roleModels },
        // Clamp here rather than at each control: this is the single funnel, and
        // an `<input type="number">` reports "" (→ 0) when cleared, which would
        // otherwise persist "never refine the plan" as a silent misconfiguration.
        adversarial: {
          ...adversarial,
          confidenceThreshold: clamp(adversarial.confidenceThreshold, 0, 1),
          maxIterations: Math.round(clamp(adversarial.maxIterations || 1, 1, 5)),
        },
      }
      await saveValue('agentSettings', this.agent)
    },

    /** The Ollama model a pipeline role runs on (blank inherits `chatModel`). */
    modelForRole(role: ModelRole): string {
      return resolveRoleModel(this.agent.roleModels, role, this.indexing.chatModel)
    },

    /** Global settings merged with a project's overrides. */
    effective(override?: Partial<EditorSettings>): EditorSettings {
      return { ...this.editor, ...(override ?? {}) }
    },
  },
})
