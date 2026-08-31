---
name: design-system-primitives
description: Exact APIs for Button, IconButton, Badge, SectionHeader, InlineInput as found in components/ui/
metadata:
  type: reference
---

All primitives live in `src/components/ui/`.

**IconButton** — icon-only, accessible.
Props: `icon` (FunctionalComponent), `label` (string, becomes title+aria-label), `size` ('sm'|'md'|'lg', default 'sm'), `variant` ('ghost'|'plain', default 'ghost'), `type`, `disabled`.
Icon sizes (verified 2026-08-24): sm=size-3.5 (14px), md=size-4 (16px), lg=size-5 (20px). No dedicated "icon-size-*" utility class family exists — sizes are per-component computed classes (`iconClass` in IconButton.vue), not a shared token.
ghost = padded hover chip (rounded p-1 text-subtle hover:bg-hover hover:text-fg).
plain = bare icon color shift only (text-subtle hover:text-fg).

**Button** — text/labelled button, leading icon via slot (no dedicated icon prop; caller composes `<Icon class="size-3.5" /> Label` in the default slot).
Props: `variant` ('primary'|'secondary'|'ghost'|'danger', default 'secondary'), `size` ('sm'|'md', default 'sm'), `block`, `type`, `disabled`.
sm = rounded px-2.5 py-1 text-sm. md = rounded-md px-3.5 py-2 text-base.
Purely presentational/synchronous — no loading/pending state, no spinner. See [[action-button-proposal]] for the async-action-button design filling this gap.

**Badge** — status pill.
Props: `tone` ('accent'|'warn'|'danger'|'neutral', default 'neutral'), `uppercase`.
accent=bg-accent/15 text-accent, warn=bg-yellow/20 text-yellow, danger=bg-red/20 text-red, neutral=bg-line text-muted.
Always text-2xs tabular-nums tracking-wide.

**SectionHeader** — panel section header. Props: `bordered` (default true).
Default slot = label (rendered text-xs uppercase tracking-[0.12em] text-subtle).
Named slot `#actions` = right-aligned row of action buttons.

**InlineInput** — autofocusing rename/create field.
Props: `initial`, `placeholder`, `icon` (FunctionalComponent).
Emits: `commit(value: string)`, `cancel()`.
Enter commits, Esc cancels, blur commits. Single-fire (settled guard).
Styling: border-accent bg-elevated text-sm text-fg.

**Type scale**: text-2xs (9px), text-xs (11px), text-sm (12.5px), text-base (13px). Fixed at exactly these 4 steps per CLAUDE.md — never `text-[Npx]`.
**Color tokens (verified 2026-08-24, src/style.css @theme block — supersedes any older values recorded here)**: --color-bg #1e1e1e, --color-surface #262626, --color-elevated #2d2d2d, --color-hover #353535, --color-active #3e3e3e, --color-line #353535, --color-fg #e0e0e0, --color-muted #a3a3a3, --color-subtle #767676, --color-accent #F2778A, --color-green #87a03b, --color-yellow #f08501, --color-red #ff9200. (A `:root` legacy CSS-var block mirrors these same values for scoped styles + the Dockview theme only.)
**@theme utilities**: bg-bg, bg-surface, bg-elevated, bg-hover, bg-active, border-line, text-fg, text-muted, text-subtle, text-accent, text-green, text-yellow, text-red.
**Font mono**: --font-mono = 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace.
**Icon set**: `@heroicons/vue/20/solid` (not lucide) — e.g. PlusIcon, ChevronRightIcon, FolderIcon, ArrowRightStartOnRectangleIcon.
**No `src/composables/` directory exists.** Shared reactive logic outside Pinia stores lives as small `services/*.ts` modules exporting a `reactive()` singleton + plain functions (e.g. `services/crucibleState.ts`, `services/notifications.ts`) or imperative singleton triggers (`services/confirm.ts`, `services/contextMenu.ts`). A Vue `useX()` composable pattern would be a new precedent for this app.
**Spinner/loading primitive now exists** (shipped 2026-08-24): `components/ui/Spinner.vue` (`size` xs/sm/md, `tone` current/accent/muted, `animate-spin motion-reduce:animate-none`) plus `components/ui/ActionButton.vue` (state-aware Save→Saving→Saved button, wraps `Button`) and `services/conjugate.ts` (compromise-backed verb conjugation). Full APIs and known review gaps in [[action-button-proposal]]. Existing ad hoc in-flight signaling that should eventually migrate to these (not yet done — migration is a separate scoped step): plain "loading…" text (ProjectsManager.vue), a `:disabled` boolean with no visual change (StatusTray.vue git-refresh button), static color-coded glyphs with no motion (StatusTray.vue `●`/`○` connection dot).
