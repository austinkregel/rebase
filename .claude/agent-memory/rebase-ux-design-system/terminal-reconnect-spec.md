---
name: terminal-reconnect-spec
description: UX decisions for terminal reconnect/resume, env config, and resilience affordances (2026-06-14)
metadata:
  type: project
---

Problem context documented 2026-06-14:
- PTY sessions are children of the agent process context; socket drop kills them.
- env is stripped to a minimal allowlist (PATH/HOME/USER/LANG/LC_ALL/TERM/TMPDIR), no rc files sourced.
- No reattach protocol exists yet on agent side. Sessions die on disconnect.

Key UX decisions reached:
- New TerminalStatus values: `detached` (socket dropped, shell may be alive) and `reattaching` (reconnect in progress, trying shell_attach).
- Reconnect overlay: dim the xterm buffer with opacity-50, show a pulsing `bg-yellow` dot and inline text "Reconnecting..." inside the terminal toolbar (no toast for transient drops under ~3s).
- If reattach succeeds: fade overlay off, write a dim "\r\n[reconnected]\r\n" line in the buffer (no toast). Dot goes green.
- If reattach fails after N attempts: status becomes `closed`, write "[session lost]" in buffer, show sticky `notify.warning` with "Reattach failed" + "Restart shell" action. Do NOT auto-restart.
- TerminalsView dot colors: detached = `bg-yellow animate-pulse`, reattaching = `bg-yellow` (no pulse — already busy), closed-with-detach = `bg-red`.
- Login shell default: YES — launch as login+interactive (`-l -i` for bash/zsh, `/etc/profile` + rc loaded). Make it the default. Justify: developer expectation beats minimal-env-posture; secrets in env is a threat model for bash -> process substitution, not login shells per se.
- Settings surface: add "Login shell" toggle (Switch component, same pattern as editor toggles) in EditorSettingsForm under a new "terminal" SectionHeader section. Default on. Per-server override is v2.
- Resilience affordance: no special UI for "this session survives disconnects" — it should Just Work. If it does, the user never needs to know. If it doesn't (reattach failed), the notification + buffer message tell the story.

Related: [[terminal-overhaul-spec]]

Why: Session dies on apt upgrade because PTY ctx tied to connection. UX must not alarm on transient drops but must be clear when session is truly lost.
How to apply: Use these decisions when reviewing reconnect implementation and settings form extension.
