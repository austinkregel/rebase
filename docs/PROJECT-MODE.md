# Project mode — the IDE mode

The primary way to work on a project. Outside it you are looking at a *fleet* —
every linked server, every saved project, the whole control plane. Inside it the
app is an **IDE scoped to one project on one server**: the file tree, git, chat,
completion, terminals, and editor layout all resolve against that single project,
and a scope boundary keeps the agent from reaching outside it.

The mode is local app behaviour — Tauri + Vue. It changes **nothing** about the
transport, the `{event, data}` protocol, or the connection architecture, adds no
new events, and is invisible to the control plane and the agent. It also adds no
new navigation paradigm: it reuses the tabs, columns, and stores that already
exist. The only new surfaces are one column-2 tab and one status-tray segment.

## The two modes

|                   | Fleet mode (the shell)                      | Project (IDE) mode                                   |
| ----------------- | ------------------------------------------- | ---------------------------------------------------- |
| Servers column    | expanded, all agents + telemetry             | collapsed to the rail, the project's server only     |
| Column 2          | Files / Projects / IDE settings              | + **Project** tab, auto-selected                      |
| Projects list     | every project, every server                  | the open one expanded, rest still listed             |
| Editor tabs       | one global Dockview layout                   | layout saved per project                             |
| New terminals     | shell's default cwd                          | the project's primary root, titled with the project  |
| Chat / agent      | the active project's primary root            | **locked** to the project's server + root set        |
| Agent file scope  | one root, `..`/absolute rejected             | the **union of the project's roots**, else refused   |
| Status tray       | server · ping · git                          | `◆ project` segment, click to exit                   |

Project mode is a **soft** focus, not a lock on the *connection*. The servers
rail stays on screen with a single dot; clicking it expands the full list.
Nothing on the network becomes unreachable — glancing at a neighbouring host does
not force you out of the mode. What *is* hard is the **agent scope boundary**
(below): the chat agent cannot read or write outside the project's roots even
while you can still look at other hosts by hand.

## Entering and leaving

Deliberately few doors. Entering is an explicit act — you *open* a project — not
something a stray click does.

**Two ways in, and only two:**

- **Double-click** a project row in the Projects list.
- **Right-click** a project row → **Open**.

Both call `enterProjectMode(p.id)`. A plain single-click keeps its current
meaning (preview: set `activeId`, select the agent, expand roots inline) — it
does **not** enter the mode. This is why `activeId` and `focusedId` stay separate
(see State): opening for a look and committing to the IDE are different intents.

**Ways out:**

- The **`◆ project` status-tray segment** — always visible while in the mode;
  click it to exit. This is the primary escape hatch and the "you are in a mode"
  signal.
- The **exit button** in the Project tab header.
- Implicitly on `logout()` and when the focused project is deleted.

No command-palette entries and no keybinding for now — the existing navigation is
sufficient, and two obvious doors beat six subtle ones. (A `⌘⇧O` toggle is a
trivial later addition against the same `toggleProjectMode` action if it's ever
wanted.)

## State

A project is already bound to exactly one server (`Project.clientId`), so "which
server" needs no separate answer. The mode adds one field.

`stores/projects.ts`:

```ts
state: {
  projects: Project[]
  activeId: string | null       // which project is "open for a look" (unchanged)
  focusedId: string | null      // NEW — non-null means we are in IDE mode
  expandedIds: Set<string>
}

getters: {
  focused: Project | null       // projects.find(p => p.id === focusedId)
  inProjectMode: boolean        // focusedId !== null
}
```

`focusedId` persists into the existing `ProjectsUi` blob (`projects-ui`) beside
`activeId` and `expandedIds`, and is dropped on load if the project no longer
exists — the same guard the other two already use.

`activeId` and `focusedId` stay separate on purpose. `activeId` answers "which
project do the file tree and inline preview resolve against" and is set by a
single click. `focusedId` answers "are we in IDE mode, scoped and guarded".
Entering implies opening (`focusedId` set ⇒ `activeId` set to the same id), but
opening does not imply entering.

### Actions

```ts
enterProjectMode(id: string)   // open(id), then set focusedId + persist
exitProjectMode()              // clear focusedId + persist; activeId survives
toggleProjectMode(id?: string) // id ?? activeId ?? focusedId
```

`enterProjectMode` reuses `open()` verbatim — it already selects the agent,
persists UI state, and kicks a git refresh against the primary root. It then also
selects the project's own server explicitly (see the scope boundary: the agent's
`clientId` must be the *project's*, not whatever was last active).

## The Project tab

A fourth entry in column 2's tab strip, present only when `inProjectMode`, and
auto-selected on entry. It is *not* the Projects list with a filter — it answers
"what is the state of the project I am in", not "which project do I want".

```
[files] [projects] [◆ project] [gear]
──────────────────────────────────────
 ◆ rebase                       [exit]
   Mnemosyne  ●  cpu 2%  mem 19%
   main ↑2 · 3 changed
   scope: 2 roots · agent confined ⓘ
──────────────────────────────────────
 ▾ rebase/
   ▸ src/
   ▸ docs/
 ▾ rebase-indexer/
   ▸ src/
```

Top to bottom:

- **Project name** + exit button. Inline rename via the existing `InlineInput`.
- **The one server**, as a compact telemetry row (not the full card) — you want
  to notice it going red, not to monitor it.
- **Git**, from the existing `git` store against the primary root; a root
  switcher only when `rootPaths.length > 1`.
- **Scope line** — how many roots the agent is confined to, with a tooltip
  listing them. This is the visible face of the guardrail (below).
- **The roots as trees**, reusing `FileTreeItem` exactly as `ProjectsManager`
  does today, minus the project-row wrapper.

New file: `src/components/panels/ProjectFocus.vue`, registered by the projects
plugin (`src/plugins/projects/index.ts`) as a second `registerView` with
`location: 'sidebar.project'` and an `order` after Projects — consistent with how
the Projects tab itself is contributed, so no new hardcoded tab in
`ProjectColumn.vue`. The tab strip is icon-only, so the Project tab needs a
distinct icon (e.g. `ViewfinderCircleIcon`, outline/solid pair) that doesn't
collide with the folder, beaker, and gear.

## Shell consequences

The mode's *consequences* live in the shell, not in the store — the store never
reaches into Workbench refs. Five of them.

### 1. Servers column collapses

`Workbench.vue` owns `serversOpen`, persisted in the frame blob under `frame.v1`
(legacy fallback `rebase.frame.v1`). A watcher saves-and-restores it across the
mode transition:

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
column collapsed all day should not have it thrown open for leaving a project.
The user can still expand it by hand while in the mode — the watcher only fires on
the transition, so that stays sticky. The collapsed rail filters its dots to the
focused project's server (with the others still one click away), and
`AgentPicker.vue` pins that server to the top and dims the rest at `opacity-50`.

### 2. Per-project editor layout

Today `Workbench.vue` saves one Dockview layout under `editor.v2` (legacy
fallback `rebase.editor.v2`) and wipes every editor panel when `activeClientId`
changes. Entering a project changes the agent, so today's behaviour already
closes your tabs — you just don't get them back. Key the layout by project:

```ts
const layoutKey = () => (projects.focusedId ? `editor.v2:${projects.focusedId}` : 'editor.v2')
```

On a mode transition: serialize to the *old* key, `api.clear()`, then hydrate
from the new one. The existing `onDidLayoutChange` handler writes to
`layoutKey()`. Both layout and frame persist through `services/store.ts`, so on
desktop the layout lands in the store beside the `projects` array it is keyed on,
and `projects.remove()` prunes the orphaned `editor.v2:<id>` key.

### 3. Terminals default to the project root

`dock.openTerminal` already accepts `initialCwd`. In project mode, default it —
guarded so a terminal explicitly opened against another host is not `cd`'d into a
path that doesn't exist there:

```ts
const clientId = opts?.clientId ?? session.activeClientId
const initialCwd = opts?.initialCwd
  ?? (projects.inProjectMode && clientId === projects.focused?.clientId
      ? projects.primaryRoot ?? undefined
      : undefined)
```

Title the panel `Terminal N · <project>` in the mode.

### 4. Status-tray segment

`StatusTray.vue` / `StatusItems.vue` gain a `◆ <project>` segment, left of the
server name, shown only when `inProjectMode`. Click exits. This is the
always-visible mode signal and the escape hatch when the column-2 tab is off
screen.

### 5. Chat scoped and locked (leads into the guardrail)

Today `CrucibleChat.vue` binds to `projects.active`, resolves its root as
`rootPaths[0]`, and addresses `session.activeClientId`. In project mode it binds
to `projects.focused`, and — critically — the agent's `clientId` is **locked to
`project.clientId`**, not to whatever agent happens to be active. See below.

## Project scope boundary (the guardrail)

The point of an "IDE mode" is confidence: ask the agent to build something and
know it will touch **only this project's files on this project's host** — not a
sibling project, not another server, not `/etc` or `/root`, unless a project root
explicitly includes that path.

### What already exists

The chat agent's tools (`services/crucibleTools.ts`) already run every path
through `resolveInRoot(root, rel)`, which **rejects absolute paths and any `..`
escape**. `ToolCtx` already carries a single `root` and `clientId`. So today's
chat is already confined — but to *one* root (`rootPaths[0]`) on
`session.activeClientId`. The gap for a multi-root project on its own server is
small and mechanical.

### The three changes

1. **Lock the server.** In project mode, `ToolCtx.clientId = project.clientId`,
   full stop — never `session.activeClientId`. The user can browse another host
   in the servers rail without the agent following them there.

2. **Widen the boundary to the root set.** Replace the single `ToolCtx.root` with
   the project's `rootPaths`, resolved by the new `resolveInScope(roots, rel)`: a
   model-supplied path resolves under whichever root it names (or the primary
   root for a bare relative path), and is **refused if the resolved absolute path
   is not contained by any project root**. Containment is a normalized prefix
   check on cleaned paths (trailing slash stripped, `..` rejected), not a raw
   `startsWith`, so `/proj/../etc` and `/project-evil` can't sneak past
   `/project`. Windows roots (drive letters, backslashes) are handled — the check
   folds case and normalizes slashes when any root is Windows-style — because the
   release builds ship a Windows target, so this is exercised, not hypothetical.

3. **Refuse, visibly.** An out-of-scope path throws a clear tool error the model
   sees (`path is outside the project scope: <p>`), and the attempt surfaces in
   the chat feed like any other tool call — so a blocked reach is *observable*,
   not silent. The Project tab's scope line names how many roots are in bounds.

### Honest trust boundary

This is a **client-side mediation gate**, and it is worth being precise about what
that does and does not buy:

- It is enforced because **the app is what turns the model's tool calls into
  protocol requests**. The read/write/edit tools cannot emit an out-of-scope path
  because `resolveInRoot` refuses to build one. Against the agent as driven by
  this app, the file boundary is real and hard.
- It is **not** a server- or agent-enforced sandbox. The control plane and agent
  will still honour any in-protocol request; a different client, or a bug that
  bypasses `resolveInRoot`, is not stopped by this. Server-side path scoping is a
  future hardening, out of scope here (it would be a protocol/agent change, which
  this mode explicitly is not).
- **`run_command` is not sandboxed by cwd.** Setting a command's working dir to a
  project root does not stop `cat /etc/shadow` or `rm -rf ~`. A shell is a shell.
  So we govern it the way **Claude Code** governs Bash — a permission model, not a
  jail:
  - **Deny rules win.** An agent *deny* list (`settings.indexing.agentCommandsDeny`,
    prefix patterns, edited in Settings ▸ Indexing) refuses a matching command
    outright — no prompt, no override.
  - **Allow rules run silently.** A command matching the *allow* list
    (`settings.indexing.agentCommands`) runs without a prompt — that is what
    "allowlisted" means.
  - **Everything else asks, and offers to remember.** A command matched by
    neither list prompts the user with **Allow once / Allow always / Deny**.
    "Allow always" persists the command's prefix into the allow list so the same
    shape never re-prompts — exactly Claude Code's "don't ask again for `npm
    run test:*`" behaviour. This replaces today's hard *throw* on a
    non-allowlisted command (a dead end the model can't recover from) with an
    interactive grant.

  The approval prompt states plainly that a shell command can reach outside the
  project — we do not imply the cwd confines it.

The doc's claim, stated exactly: **file reads, writes, and edits by the chat
agent are hard-confined to the project's roots; shell commands follow a Claude
Code–style allow / deny / ask-with-remember permission model, not the path
boundary.** That is the guarantee we make and the one we don't.

## Edge cases

- **Server drops.** `socket` close nulls `activeClientId` and resets the files
  store. Project mode must *survive* this — dropping out on a flaky connection is
  worse than the connection. Show an inline banner in the Project tab
  ("Mnemosyne is offline — reconnecting") and re-select the focused project's
  `clientId` when it reappears in `client_list`. (This dovetails with the
  clientId-drift auto-heal already in `ProjectsManager.vue`.)
- **Focused project deleted.** `projects.remove()` already clears `activeId`;
  clear `focusedId` too (drops the mode) and prune its `editor.v2:<id>` layout.
- **Project with zero roots.** `startNewProject` creates projects with
  `rootPaths: []`. The Project tab shows an "Add directory…" affordance instead
  of an empty void, and the agent scope is empty — every file tool refuses until
  a root exists, which is the correct, safe default.
- **Case/id drift on the project's server.** The scope lock uses
  `project.clientId`; the auto-heal watcher keeps that pointing at the live agent,
  so entering a project whose server re-registered still binds to the right host.

## Files touched

| File                                          | Change                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `src/stores/projects.ts`                      | `focusedId`, `focused`, `inProjectMode`, enter/exit/toggle, persist, prune |
| `src/services/shell.ts`                       | **new** — the `focusProjectTab` bridge                                    |
| `src/components/panels/ProjectFocus.vue`      | **new** — the Project (IDE) tab, incl. the scope line                     |
| `src/services/views.ts`                       | optional `visible?()` predicate on a view                                 |
| `src/components/columns/ProjectColumn.vue`    | controlled `TabGroup`, filter hidden views, register the bridge           |
| `src/plugins/projects/index.ts`               | register the Project view (`visible: inProjectMode`)                       |
| `src/components/ProjectsManager.vue`          | `@dblclick` → enter; context-menu **Open** enters the mode                |
| `src/components/Workbench.vue`                | servers watcher, rail dim, per-project `layoutKey`, terminal cwd/title     |
| `src/components/AgentPicker.vue`              | pin + dim the focused server in project mode                              |
| `src/components/StatusTray.vue`               | `◆ project` segment + exit                                                |
| `src/services/dock.ts`                        | terminal `initialCwd` (already present; now defaulted in Workbench)       |
| `src/services/crucibleTools.ts`               | `ToolCtx.roots`; `resolveInScope`; deny helper; run_command permission flow |
| `src/services/crucibleChat.ts`               | pass `roots` + deny + `rememberCommand`; decision-returning approval        |
| `src/stores/settings.ts`                      | `agentCommandsDeny` (deny rules)                                           |
| `src/components/EditorSettingsForm.vue`       | allow/deny command lists in Settings ▸ Indexing (allow copy updated)      |
| `src/stores/session.ts`                       | `logout()` exits project mode                                             |
| `src/stores/projects.test.ts`                 | enter/exit/toggle, persistence, delete-while-focused                      |
| `src/services/crucibleTools.test.ts`          | multi-root containment (in-scope passes, out-of-scope refused), deny rules |

Design-system notes: the whole tab is built from `components/ui/` primitives
(`SectionHeader`, `IconButton`, `Badge`, `InlineInput`) and the four `@theme`
type steps — project name at `text-sm`, server/git/scope metadata at `text-xs`,
no new sizes.

## Build order

1. **State** — `focusedId` + getters + actions + persistence, with tests. Inert
   until something reads it.
2. **Entry + tab** — `ProjectFocus.vue`, the two doors (`@dblclick`, context
   **Open**), the status-tray segment. The mode is now enterable and visible.
3. **Guardrail** — `ToolCtx.roots`, multi-root `resolveInRoot`, clientId lock,
   the scope line + refusal, with tests. This is the load-bearing safety work.
4. **Shell polish** — per-project layout, servers collapse/dim, terminal cwd.
   Each is independent and can land in any order.
