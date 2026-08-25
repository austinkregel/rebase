# Constraining tool authority: references (#2) + grammar (#3)

The principle: the model **chooses** which tool to use; a deterministic engine
constrains the **arguments**. Every tool argument sits on a spectrum, and the goal
is to drag the dangerous ones leftward:

- **Engine-derived** — the layer computes it; the model never touches it.
- **Constrained choice** — the model picks from a bounded set the engine surfaced.
- **Model-authored free text** — raw string; minimize, and keep only where the
  value is inherently generative (code `content`, a search `query`).

These two designs compose: #2 supplies the bounded set, #3 makes it *unforgeable
at generation time*.

---

## #2 — Address files by what was surfaced, not by raw path

Layered on top of `resolveInScope` (which confines paths to the project roots).
This adds: the model may only **mutate** files it has actually seen, and only
**create** files inside directories it has listed.

### The surfaced-set registry (per conversation)

A conversation-scoped record, threaded through `ToolCtx`:

```ts
interface Surfaced {
  files: Set<string> // canonical abs paths revealed by read/list/search/grep
  dirs:  Set<string> // canonical abs dirs revealed by list_files
}
```

- **Reads populate it, and stay path-based.** `read_file`, `list_files`,
  `search_code`, `grep` keep taking a scope-checked path (reading widely is how
  the model discovers, and it's low blast-radius). Every file/dir they reveal is
  added to `Surfaced`.
- **Mutations consult it, deterministically.**
  - `edit_file` / `write_file` on an **existing** target: refuse unless the
    resolved path is in `Surfaced.files`. *You can only edit what you've read.*
  - `write_file` creating a **new** file: takes a surfaced **directory** + a
    validated leaf `name` (no separators, no `..`); the engine joins them. *You
    can only create inside a directory you've listed.*
  - Anything else → a clear refusal telling the model to read/list first.

This is defense-in-depth over scope confinement: even within the allowed roots,
the model can't blind-fire an edit at a path it merely guessed — it has to have
surfaced it, which the system prompt already tells it to do ("investigate before
editing"). Ergonomic cost is near zero; the discipline is the point.

### Where it lives

`services/crucibleState.ts` gains the per-conversation `Surfaced` (like `pins`/
`turns` are keyed by conversation), `ask()` passes it into each `ToolCtx`, and
`runTool` reads-populate / mutation-check against it.

---

## #3 — Grammar-constrain the arguments (token-level, not after-the-fact)

Ollama's `format` accepts a **JSON schema** (structured outputs, backed by
llama.cpp GBNF) — the sampler physically cannot emit tokens that violate it. The
plumbing already exists end-to-end but is dormant and typed as `String`; we widen
it to a value (string **or** schema object) and start using it.

### Two phases: the model chooses, the engine constrains

This maps directly onto "LLM picks the tool, engine does the args":

- **Phase A — selection (native tool-calling).** Keep the current `tools` array.
  The model emits a `tool_call`; we take only the **tool name** (models are
  trained to *select* well this way — better than forcing selection through a
  JSON union).
- **Phase B — argument synthesis (grammar-locked).** A second generation with
  `format` = the **chosen tool's JSON schema**. The args come back valid *by
  construction*, then pass a deterministic validator (belt) before execution.

Free-text fields (`content`, `query`, `pattern`) stay unconstrained — they're
inherently generative. The grammar targets the **authority** fields (the target,
enums, bounded options), which is exactly where it matters.

**Adaptive optimization:** Phase A's `tool_call` usually already carries draft
args. Validate them against the schema first; only run Phase B (the extra call)
when a *constrained* field is missing/invalid. So the second round-trip is paid
only when the model actually got a constrained arg wrong — often never.

---

## The synthesis — why #2 + #3 together is the real win

Build the Phase-B schema **fresh each step** from the live `Surfaced` set. The
mutation-target field becomes an enum of exactly the files/dirs surfaced so far:

```jsonc
// edit_file args schema, generated this step:
{
  "type": "object",
  "properties": {
    "target": { "enum": ["src/foo.ts", "src/bar.ts", "docs/x.md"] }, // = Surfaced.files
    "old_text": { "type": "string" },   // free — it's code
    "new_text": { "type": "string" }
  },
  "required": ["target", "old_text", "new_text"]
}
```

Now the model **cannot even emit** a target that wasn't surfaced — not "we
validate and reject after," but the sampler can't produce it. #2 defines the set;
#3 enforces it at the token. The model still *chooses* among real files; it has
zero authority to invent one.

---

## Feasibility & changes

| Where | Change |
| ----- | ------ |
| `src-tauri/src/crucible.rs` | `format: Option<String>` → `Option<serde_json::Value>`, passed through to `body["format"]` (tiny; the insert already exists). |
| `src/services/crucibleChat.ts` | `StreamOptions.format: 'json' \| object`; the two-phase step in `ask()`; adaptive Phase-B trigger. |
| `src/services/crucibleTools.ts` | per-tool JSON-schema generators (fed the live `Surfaced` set); reads populate the registry; mutations gate on it. |
| `src/services/crucibleState.ts` | the per-conversation `Surfaced` registry. |

## Honest caveats

- **Latency:** Phase B is a second call. Mitigated by the adaptive trigger and by
  skipping it for free-text-only tools.
- **Model/Ollama floor:** schema `format` needs Ollama ≥ 0.5. If unavailable or
  unenforced, degrade gracefully to **#2 as validate-only** (the model emits a
  path, we reject if not surfaced) — still deterministic, just not token-level.
- **Selection stays native** precisely because structured-output *selection* can
  be worse than trained tool-calling for some models; we only grammar-lock args.
- The registry is conversation-scoped state — an edit in a later turn can
  reference a file read earlier, matching how a person works.

## Tests

- **#2 (pure, no Ollama):** edit/write to an un-surfaced path refused; to a read
  file allowed; new file in a listed dir allowed, in an unlisted dir refused;
  leaf-name validation (`/`, `..` rejected). Registry populates on read/list.
- **#3:** the schema generator emits the correct `enum` from a given `Surfaced`
  set; `format` value (object) round-trips through `crucible_chat` (Rust test);
  adaptive Phase B fires only when a constrained field is invalid.

## Build order

1. **#2 registry + mutation gating** — pure TS, fully testable now, no Ollama.
2. **Rust `format` → value** — unlocks schemas.
3. **#3 schema generators + two-phase loop** — with the adaptive trigger.
4. **Synthesis** — feed `Surfaced` into the target field's enum.
