---
name: action-button-proposal
description: State-aware "grammatically living" ActionButton — shipped primitives (ActionButton.vue, Spinner.vue, services/conjugate.ts), their real APIs, and open review findings
metadata:
  type: project
---

**Status (2026-08-24): implemented and reviewed, not yet migrated to any call site** (that's a
deliberately separate scoped step per the coordinator). Full suite + typecheck reported green at
implementation time; treat that as a point-in-time claim, re-run before trusting it later.

Three new files, all under design-system ownership:
- `src/services/conjugate.ts` — `conjugate(label: string, overrides?: Partial<ActionLabels>): ActionLabels`, `ActionLabels = {idle,pending,success,error}`. Backed by `compromise` (npm `compromise`, v14.16.0, now a real dependency). Conjugates only the verb token via `nlp(label).verbs().first().conjugate()` and reattaches the rest of the phrase in place (so "Build index" → "Building index…" / "Built index" — matches CLAUDE.md's own example), memoized in a module-level `Map`, falls back to the untouched label when no verb is found (e.g. "Preferences"), every field individually overridable. Tests in `conjugate.test.ts` (7 cases: regular verb, irregular morphology, multi-word phrase order, capitalization match, override, no-verb fallback, whitespace trim) — read as legitimate, not rubber-stamped.
- `src/components/ui/Spinner.vue` — `size` ('xs'|'sm'|'md' → size-3/3.5/4, reusing IconButton's icon scale), `tone` ('current'|'accent'|'muted' → text-current/text-accent/text-subtle, default 'current'), `label` (default 'Loading', feeds `aria-label`). SVG ring, `animate-spin motion-reduce:animate-none`, `role="status"`. **As reviewed, had no way to suppress its own `role="status"`/`aria-label` for embedded use** — see review findings below; may have since gained a `decorative` prop.
- `src/components/ui/ActionButton.vue` — wraps `Button` (never reimplements its chrome). Props: `label` (base verb), `states?` (Partial<ActionLabels> overrides — includes `idle`, flagged as a footgun below), `action?` (uncontrolled mode, `() => Promise<unknown>`), `state?`/`phaseLabel?` (controlled mode, mirrors an external phase machine), `icon?`, `variant` (default **'primary'**, unlike Button's default 'secondary' — intentional), `size`, `block`, `type`, `disabled` (genuine unavailability only), `minPendingMs` (400), `successHoldMs` (1200, 0 disables). Emits `trigger`/`retry`/`success`/`error`/`settle`. Uses `aria-disabled` (not native `disabled`) for the in-flight lock specifically so focus survives the state change and `Button`'s `disabled:opacity-50` doesn't fire mid-flight — this was a hard requirement from the original proposal and it's implemented exactly right. Has a `generation` counter guarding against a stale timer resolving after the user re-triggers mid-flight — good defensive addition beyond the original proposal.

**Review findings (2026-08-24, not yet fixed as of this review):**
1. **A11y bug, not cosmetic**: `Spinner`'s own `role="status" aria-label="Loading"` fires as a second, competing live-region announcement alongside `ActionButton`'s `aria-live="polite"` label span — a screen reader hears both "Loading" and "Saving…" for one transition. Fix proposed: add `decorative?: boolean` to `Spinner` (→ `aria-hidden="true"`, drop role/label) and have `ActionButton` pass it on its embedded instance; keep `role="status"` as the default for standalone uses (e.g. replacing `ProjectsManager.vue`'s plain "loading…" text).
2. **Visual gap**: `ActionButton` hardcodes `Spinner size="sm"` and `size-3.5` for Check/ArrowPath/icon regardless of its own `size` prop — a `size="md"` ActionButton gets `sm`-scaled icons, unlike `Button`/`IconButton`'s established convention of icons stepping up with control size (14px→16px). Fix proposed: map `size` → icon size the same way `IconButton` does.
3. **Minor type nit**: `states.idle` can be overridden independently of `label`, but `pending`/`success` are still derived from `label` alone — can silently produce a mismatched idle vs. in-flight grammar. Proposed narrowing to `Partial<Omit<ActionLabels,'idle'>>`.

None of these are blocking/revert-worthy; 1 and 2 are small fixes, 3 is a nice-to-have. Original proposal content preserved below for the reasoning trail.

**Why now:** audited the app and found zero standardized loading affordance — ProjectsManager.vue's
"Save" button in the new-project form has *no* pending state at all despite awaiting a networked
`projects.create()`; StatusTray.vue's git-refresh button only toggles `:disabled`, no visual;
the connection dot is a static colored glyph. See [[design-system-primitives]] for the full audit
(no Spinner primitive, no `animate-spin` usage, no `composables/` dir precedent).

**Key design decisions proposed (not yet confirmed by user):**
- New primitive, not a `Button` prop — Button.vue stays pure/synchronous by rule; anything that
  awaits a promise goes through ActionButton instead. Open question, needs user confirmation.
- Two operating modes: **uncontrolled** (`:action="fn"` — button owns its own idle→pending→
  success/error timing; covers most one-shot Save/Delete-style calls) and **controlled**
  (`:state="..."` driven by external phase — needed because real async flows in this app are
  *already* externally phased: `stores/session.ts` has `Phase = loading|unauthenticated|
  disconnected|connecting|connected` (a "Connect" button must reflect an in-flight connect it
  didn't itself trigger, since a single control plane auto-connects on startup — session.ts
  line ~58), and `services/crucibleState.ts` has `IndexPhase = idle|uploading|building|packing|
  downloading|ready|stale|error` for "Build index", which needs more than 2 in-flight labels.
- Explicit `states: {idle,pending,success,error}` object as the primary API (not
  auto-conjugation) — verbs like "Build index" → "Index built" invert word order, so a
  grammar-guessing helper would mislead more than it'd save. A tiny `conjugate()` sugar helper
  for the trivial regular-verb case (Save/Saving/Saved) can be offered as opt-in, not primary.
- Error state is sticky (no auto-revert timeout) — matches existing precedent, e.g.
  ProjectsManager's `errors[key]` inline red text persists until the user acts, never
  auto-dismisses. Success state auto-reverts after a short hold (~1.2s default).
- In-flight guard should use `aria-disabled` + an internal reentrancy guard, not the native
  `disabled` attribute — native `disabled` has inconsistent focus/blur behavior across browsers
  mid-interaction and would fight focus retention during the pending state.
- Minimum pending duration (~400ms default) to prevent fast actions from flashing the spinner.

Full proposal (props/slots/events, Spinner API, call-site sketches for ProjectsManager save,
Crucible build-index, and session connect) was written out in-conversation, not committed to a
file. If asked to revisit or implement, re-derive from these decision points plus a fresh read of
`src/components/ui/Button.vue`, `src/components/ui/IconButton.vue`, `src/services/crucibleState.ts`,
and `src/stores/session.ts` (state may have moved on).
