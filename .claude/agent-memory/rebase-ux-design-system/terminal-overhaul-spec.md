---
name: terminal-overhaul-spec
description: Approved UX spec for terminal panel polish, terminals manager view, and context-menu contributions (written 2026-06-13)
metadata:
  type: project
---

Full spec delivered as assistant message on 2026-06-13. Key decisions:

- Terminal toolbar: always-visible, height matches SectionHeader (py-1.5), left side = status dot + server badge, right side = IconButton actions (search, clear, restart/kill). No split in v1.
- xterm background = --color-bg (#0d1117), NOT surface. Full Tokyo Night ANSI palette specified.
- Font from editor settings fontSize, family from --font-mono CSS var (read at mount + watch).
- Search box: absolute overlay top-right of terminal host div, not InlineInput (InlineInput commits on blur). Bespoke TerminalSearchBar sub-component in src/components/panels/.
- Terminals Tools-column view: registered via services/views.ts at location sidebar.tools. Row pattern mirrors ProjectsManager rows. SectionHeader with + (IconButton) and kill all (Button variant=danger).
- Tab titles: shell name if known, else "Terminal N". Exited: suffix " [exited]" or " [N]" for non-zero exit.
- Context menu inside terminal: openContextMenu from services/contextMenu.ts. Items: Copy/Paste/Select All/Clear/New Terminal.
- New MenuId 'terminal/context' added to menus.ts for extensibility.
- folder/context and projectRoot/context get "Open in Terminal" contributions from terminal plugin.
- Keybindings: Ctrl+` new terminal (exists), Cmd+F terminal find (xterm-scoped), Cmd+K clear (terminal-scoped), Cmd+Shift+` focus terminal.
- Terminal decoupling: clientId baked into panel params; watch on session.activeClientId deleted.
- Terminals registry: reactive service services/terminals.ts, Map of panelId to TerminalEntry.

Why: Terminal was ad-hoc with hardcoded colors, custom buttons, and session coupling that nuked the shell on server switch.
How to apply: Use this spec as ground truth for implementation review. Flag deviations from toolbar composition, token usage, or search box approach.
