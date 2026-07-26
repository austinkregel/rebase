---
name: crucible-chat-architecture
description: CrucibleChat agent loop — groupedTurns focal-hierarchy pattern, tool card two-tier split, confirmed theme tokens
metadata:
  type: project
---

The Crucible agent loop appends one `ChatTurn` per model iteration to the transcript. One user question may produce 5+ consecutive assistant `ChatTurn` entries, each with its own tool calls and prose. Rendering each turn with its own role label produces the fragmented "5× CRUCIBLE" pattern.

**Canonical fix:** `groupedTurns` computed that annotates `showLabel: t.role !== turns[i-1]?.role` — label appears only at the first turn of each role run. Applied in `src/plugins/crucible/CrucibleChat.vue`.

**Tool card conventions established:**
- Card container: `rounded border px-2 py-1 text-2xs`, conditional class `border-red/40 bg-red/5` for error/denied status, else `border-line bg-elevated`
- Summary line: `text-xs text-fg` (one step above card default `text-2xs`)
- Error paragraph: `text-xs text-red`
- Diff/output pre blocks: explicit `text-2xs` (minimum, fine for secondary content)
- Approval buttons: `Button` primitive with `variant="primary/secondary/danger" size="sm"` — never raw `<button>`

**Design system violations fixed (2026-06-16):**
1. Repeated role labels per loop iteration → `groupedTurns` + `showLabel` gate
2. Raw `<button>` for Allow/Allow&remember/Deny → `Button` primitive (primary/secondary/danger)
3. Raw `<button>` for pin removal → `IconButton variant="plain" size="sm"`
4. Tool card summary at implicit `text-2xs` → promoted to `text-xs`
5. Error/denied cards visually identical to normal cards → `border-red/40 bg-red/5` tint

**Focal hierarchy pattern (Cursor-style, implemented 2026-06-16):**

`groupedTurns` adds three booleans beyond `showLabel`:
- `isAnswer` — last assistant turn in a run with no toolCalls. Rendered `text-sm text-fg`. The single high-contrast element.
- `isProcess` — all other assistant turns (have toolCalls or not last in run). Rendered `text-xs text-subtle`. Muted river.
- User turns always `bg-elevated text-sm text-fg` (full pill weight).

Tool card two-tier split:
- **Quiet row** (`done` + no diff + no output + no error): bare flex, `size-3 text-subtle` icon, `text-2xs text-subtle` label. No border/bg.
- **Attention card** (awaiting / error / denied / has diff or output): bordered. `border-accent/40 bg-accent/5` for awaiting; `border-red/40 bg-red/5` for error/denied; `border-line bg-elevated` for done-with-content.

Theme token audit (2026-06-16, `src/style.css`): `text-green`, `text-red`, `text-yellow`, `text-accent` are confirmed `@theme` tokens. Safe to use in toolTone/diffTone.

**Open items:**
- Citation chips are raw `<button>` — low priority, correct visual outcome already.
