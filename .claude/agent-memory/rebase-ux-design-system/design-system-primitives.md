---
name: design-system-primitives
description: Exact APIs for Button, IconButton, Badge, SectionHeader, InlineInput as found in components/ui/
metadata:
  type: reference
---

All primitives live in `src/components/ui/`.

**IconButton** — icon-only, accessible.
Props: `icon` (FunctionalComponent), `label` (string, becomes title+aria-label), `size` ('sm'|'md'|'lg', default 'sm'), `variant` ('ghost'|'plain', default 'ghost'), `type`, `disabled`.
Icon sizes: sm=size-3.5 (14px), md=size-4 (16px), lg=size-6 (24px).
ghost = padded hover chip (rounded p-1 text-subtle hover:bg-hover hover:text-fg).
plain = bare icon color shift only (text-subtle hover:text-fg).

**Button** — text/labelled button, leading icon via slot.
Props: `variant` ('primary'|'secondary'|'ghost'|'danger', default 'secondary'), `size` ('sm'|'md', default 'sm'), `block`, `type`, `disabled`.
sm = rounded px-2.5 py-1 text-sm. md = rounded-md px-3.5 py-2 text-base.

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

**Type scale**: text-2xs (9px), text-xs (11px), text-sm (12.5px), text-base (13px).
**Color tokens (legacy CSS vars, same values)**: --bg #0d1117, --bg-panel #10161d, --bg-input #161d27, --bg-hover #1a222d, --bg-active #1f2937, --border #232b36, --fg #d4dae2, --fg-muted #9aa6b2, --fg-subtle #5e6a76, --accent #7aa2f7, --green #9ece6a, --yellow #e0af68, --red #f7768e.
**@theme utilities**: bg-bg, bg-surface, bg-elevated, bg-hover, bg-active, border-line, text-fg, text-muted, text-subtle, text-accent, text-green, text-yellow, text-red.
**Font mono**: --font-mono = 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace.
