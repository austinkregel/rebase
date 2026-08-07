# Project mode

A focus mode for the workbench. Outside it you are looking at a *fleet* — every
linked server, every saved project, the whole control plane. Inside it you are
looking at *one project on one server*, and the shell gets out of the way.

The mode is pure UI state. It changes nothing about the protocol, adds no new
events, and is not visible to the control plane or the agent.

## The two modes

|                   | Fleet mode (today)                          | Project mode                                        |
| ----------------- | ------------------------------------------- | --------------------------------------------------- |
| Servers column    | expanded, all agents + telemetry             | collapsed to the rail, project's server only        |
| Column 2          | Files / Projects / IDE settings              | + **Focus** tab, auto-selected                        |
| Projects list     | every project, every server                  | the focused one expanded, rest behind "show all"    |
| Editor tabs       | one global Dockview layout                   | layout saved per project                            |
| New terminals     | shell's default cwd                          | project's primary root                              |
| Status tray       | server · ping · git                          | `◆ project` segment, click to exit                  |

Project mode is a **soft** focus, not a lock. The servers rail stays on screen
with a single dot; clicking it expands the full list with the project's server
pinned and the others dimmed. Nothing becomes unreachable — glancing at a
neighbouring host does not force you out of the mode. A hard lock reads as
tidier in a mockup and as a dead end in practice, the first time a build breaks
because a different box ran out of disk.

## State

A project is already bound to exactly one server (`Project.clientId`), so
"which server" needs no separate answer. The mode adds one field.

`stores/projects.ts`:

```ts
state: {
  projects: Project[]
  activeId: string | null       // which project is open in the list (unchanged)
  focusedId: string | null      // NEW — non-null means project mode
  expandedIds: Set<string>
}

getters: {
  focused: Project | null       // projects.find(p => p.id === focusedId)
  inProjectMode: boolean        // focusedId !== null
}
```

`focusedId` persists into the existing `ProjectsUi` blob (`projects-ui`)
alongside `activeId` and `expandedIds`, and is dropped on load if the project no
longer exists — same guard the other two already use.

`activeId` and `focusedId` stay separate on purpose. `activeId` answers "which
project do Crucible, git status, and the file tree resolve against" and is set by
plain single-click in the list. `focusedId` answers "is the shell in focus
mode". Entering implies opening (`focusedId` set ⇒ `activeId` set to the same
id), but opening does not imply entering. Collapsing them into one field would
mean every click in the Projects list re-arranges the whole window.

### Actions

```ts
enterProjectMode(id: string)   // open(id), then set focusedId + persist
exitProjectMode()              // clear focusedId + persist; activeId survives
toggleProjectMode(id?: string) // id ?? activeId ?? focusedId
```

`enterProjectMode` reuses `open()` verbatim — it already selects the agent,
persists UI state, and kicks a git refresh against the primary root.

## Shell wiring

The mode's *consequences* live in the shell, not in the store: the store never
reaches into Workbench refs. Two directions of plumbing are needed, one of which
requires a small refactor.

### Servers column (watch, downward)

`Workbench.vue` owns `serversOpen` in a local ref persisted to
`rebase.frame.v1`. Add a watcher:

```ts
let serversOpenBeforeFocus: boolean | null = null
watch(() => projects.inProjectMode, (on) => {
  if (on) {
    serversOpenBeforeFocus = serversOpen.value
    serversOpen.value = false
  } else if (serversOpenBeforeFocus !== null) {
    serversOpen.value = serversOpenBeforeFocus
    serversOpenBeforeFocus = null
  }
}, { immediate: true })
```

Save-and-restore rather than a hard `true` on exit: someone who works with the
servers column collapsed all day should not have it thrown open at them for
leaving a project. The user can still expand the column by hand while in the
mode — the watcher only fires on the mode transition, so that stays sticky.

The collapsed rail (`Workbench.vue`, the `v-else` branch) filters its dots:

```ts
const railAgents = computed(() =>
  projects.inProjectMode
    ? agents.sortedAgents.filter(a => a.clientId === projects.focused?.clientId)
    : agents.sortedAgents,
)
```

`AgentPicker.vue` sorts the focused project's server to the top and dims the
rest at `opacity-50` when `inProjectMode` — visible, still clickable, clearly
not what you are working on.

### Column 2 tab selection (capability, upward)

`ProjectColumn.vue` uses an *uncontrolled* Headless UI `TabGroup`, so nothing
outside it can select a tab. This is the one real refactor: bind
`:selected-index` / `@change` to a local ref, and expose a focus call through a
`dock.ts`-style bridge, matching the pattern the Workbench already uses for
terminals:

```ts
// services/shell.ts (new)
export const shell = reactive<{
  focusProjectTab: ((id: string) => void) | null
}>({ focusProjectTab: null })
```

`ProjectColumn` registers it on mount; `enterProjectMode` calls
`shell.focusProjectTab?.('focus')`. No-op until registered, exactly like
`dock.openTerminal`.

## The Focus tab

A fourth entry in column 2's tab strip, present only when `inProjectMode` (the
tab list is already a computed array, so this is a conditional spread). It is
*not* the Projects list with a filter applied — it is a different view answering
a different question: not "which project do I want" but "what is the state of
the one I am in".

```
[files] [projects] [◆ focus] [gear]
──────────────────────────────────
 ◆ rebase                   [exit]
   Mnemosyne  ●  cpu 2%  mem 19%
   main ↑2 · 3 changed
──────────────────────────────────
 ▾ rebase/
   ▸ src/
   ▸ docs/
 ▾ rebase-indexer/
   ▸ src/
```

Contents, top to bottom:

- **Project name** + exit button. Rename inline via the existing `InlineInput`.
- **The one server**, as a compact `ServerTelemetry` row rather than the full
  card — you want to notice it going red, not to monitor it.
- **Git**, from the existing `git` store against the primary root; a root
  switcher only when `rootPaths.length > 1`.
- **The roots as trees**, reusing `FileTreeItem` exactly as `ProjectsManager`
  does today, minus the project-row wrapper.

New file: `src/components/panels/ProjectFocus.vue`. Registered by the projects
plugin (`src/plugins/projects/index.ts`) as a second `registerView` with
`location: 'sidebar.project'`, `order: 20` — no new hardcoded tab in
`ProjectColumn`, consistent with how the Projects tab itself is contributed.

The tab strip is icon-only today, so the Focus tab needs a distinct icon —
`ViewfinderCircleIcon` (outline/solid pair) reads as "focus" without colliding
with the existing folder, beaker, and gear.

## Entering and exiting

Multiple doors, one destination:

- **Projects list** — double-click a project row, or "Enter Project Mode" in the
  row's context menu (`projectMenu` in `ProjectsManager.vue`, above "Rename"),
  or a viewfinder `IconButton` that appears on row hover.
- **Command palette** — `workspace.enterProjectMode`,
  `workspace.exitProjectMode`, `workspace.toggleProjectMode`, category
  `Workspace`. Registered in `Workbench.vue` next to the existing `view.*`
  commands. `enter` is `isEnabled: () => !!projects.activeId`.
- **Keybinding** — `⌘⇧F` for toggle. `⌘B` / `⌘J` are taken by the two sidebars;
  keep the mode on a shift-chord so it does not feel like another panel toggle.
- **Status tray** — in project mode, a `◆ rebase` segment left of the server
  name; click exits. This is the always-visible "you are in a mode" signal, and
  the escape hatch when the column-2 tab is not on screen.
- **Exit** also happens implicitly on `logout()` (clear `focusedId`).

## Per-project editor layout

Today `Workbench.vue` saves one Dockview layout under `rebase.editor.v2`, and
wipes every editor panel when `activeClientId` changes. Entering a project
changes the agent, so today's behaviour already closes your tabs — you just do
not get them back.

Key the layout by project instead:

```ts
const layoutKey = () => (projects.focusedId ? `editor.v2:${projects.focusedId}` : 'editor.v2')
```

Both the layout and the frame now persist through `services/store.ts` rather
than raw `localStorage`, which is what makes this sound: on desktop the layout
lands in `rebase.json` beside the `projects` array it is keyed on, so the key
and its referent share a lifetime and `projects.remove()` can prune orphans
without reaching across into webview storage.

On mode transition: serialize to the *old* key, `api.clear()`, then hydrate from
the new one. The existing `onDidLayoutChange` handler writes to `layoutKey()`.
This turns project mode from a visual filter into something with memory — leave
`rebase`, work in `Homelab`, come back and your five tabs are where you left
them. Prune keys for deleted projects in `projects.remove()`.

## Terminals

`dock.openTerminal` already accepts `initialCwd`. In project mode, default it:

```ts
const clientId = opts?.clientId ?? session.activeClientId
const initialCwd = opts?.initialCwd
  ?? (projects.inProjectMode && clientId === projects.focused?.clientId
      ? projects.primaryRoot ?? undefined
      : undefined)
```

Guarded on `clientId` matching so a terminal explicitly opened against another
host does not get `cd`'d into a path that does not exist there. Title the panel
`Terminal N · <project>` in the mode.

## Files tab: unchanged, on purpose

The obvious move is to have `enterProjectMode` point `browseRoot` at the
project's primary root, so the Files tab "follows" the project. Don't.

The whole point of a dedicated Focus tab is that the project's roots have a
home. If Files also shows those roots, the two tabs collide: one of them is
redundant, and the user has to remember which one is the project and which one
is wherever they last browsed. Keeping them distinct gives each tab a single
clear job — **Focus** is the project, **Files** is the ad-hoc filesystem browser
you use to *find* the next root to add. That is also the existing contract
(`projects.open()` deliberately leaves `browseRoot` alone), so project mode
changes nothing here.

`session.selectAgent()` still resets `browseRoot` to the platform default when
the agent changes, which is fine: entering a project puts you at that server's
root in Files and at the project's roots in Focus.

## Edge cases

- **Server drops.** `socket.onStatus('closed')` nulls `activeClientId` and
  resets the files store. Project mode must *survive* this — dropping out of the
  mode on a flaky connection is worse than the connection. Show an inline banner
  in the Focus tab ("Mnemosyne is offline — reconnecting"), and add a watcher on
  the agents list that re-selects the focused project's `clientId` when it
  reappears in `client_list`.
- **Focused project deleted.** `projects.remove()` already clears `activeId`;
  clear `focusedId` too, which drops the mode.
- **Project with zero roots.** `startNewProject` creates projects with
  `rootPaths: []`. The Focus tab shows the "Add Directory…" affordance in place
  of the trees rather than an empty void.
- **Multi-window / desktop.** `focusedId` lives in the same store layer as the
  rest (`services/store.ts`, tauri-plugin-store on desktop), so the mode is
  per-install, not per-window. Fine for now; worth revisiting if the desktop app
  ever opens a second window.

## Files touched

| File                                          | Change                                                        |
| --------------------------------------------- | ------------------------------------------------------------- |
| `src/stores/projects.ts`                      | `focusedId`, `focused`, `inProjectMode`, enter/exit/toggle    |
| `src/services/shell.ts`                       | **new** — `focusProjectTab` bridge                             |
| `src/components/columns/ProjectColumn.vue`    | controlled `TabGroup`, register the bridge                     |
| `src/components/panels/ProjectFocus.vue`      | **new** — the Focus tab                                        |
| `src/plugins/projects/index.ts`               | register the Focus view + the enter menu item                  |
| `src/components/Workbench.vue`                | servers watcher, rail filter, per-project layout key, commands |
| `src/components/AgentPicker.vue`              | pin + dim in project mode                                      |
| `src/components/ProjectsManager.vue`          | enter affordances, collapse others                             |
| `src/components/StatusTray.vue`               | `◆ project` segment + exit                                     |
| `src/services/dock.ts` / Workbench            | terminal `initialCwd` default                                  |
| `src/services/keybindings.ts`                 | `⌘⇧F`                                                          |
| `src/stores/projects.test.ts`                 | enter/exit, persistence, delete-while-focused                  |

Design-system notes: the whole tab is built from `components/ui/` primitives
(`SectionHeader`, `IconButton`, `Badge`, `InlineInput`) and the four `@theme`
type steps — project name at `text-sm`, the server/git metadata line at
`text-xs`, no new sizes.
