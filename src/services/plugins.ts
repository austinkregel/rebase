import { registerCommand, registerCommands, type Command } from './commands'
import { registerStatusItem, type StatusItem } from './statusBar'
import { registerMenuItem, type MenuContribution } from './menus'
import { registerView, type ViewContribution } from './views'
import { registerViewer, type ViewerContribution } from './viewers'
import { registerKeybinding, type Binding } from './keybindings'
import type { OpenTerminalOptions } from './dock'

/**
 * In-process plugin host. Plugins are trusted modules (bundled first-party for
 * now) with an `activate(ctx)` that registers contributions. Every contribution
 * the ctx makes is tracked and torn down on deactivate, so a plugin is fully
 * removable. The contribution registries are the API — kept declarative so a
 * sandbox/worker bridge can wrap this later for untrusted third-party plugins.
 */

/** Imperative app actions a plugin can't own (provided by the Workbench). */
export interface HostCapabilities {
  openTerminal: (opts?: OpenTerminalOptions) => void
}

export interface PluginContext {
  readonly id: string
  readonly host: HostCapabilities
  registerCommand: (c: Command) => void
  registerCommands: (c: Command[]) => void
  registerStatusItem: (i: StatusItem) => void
  registerMenuItem: <C>(c: MenuContribution<C>) => void
  registerView: (v: ViewContribution) => void
  registerViewer: (v: ViewerContribution) => void
  registerKeybinding: (b: Binding) => void
}

export interface RebasePlugin {
  id: string
  name: string
  activate: (ctx: PluginContext) => void | Promise<void>
  deactivate?: () => void
}

/** Identity helper so plugin modules read declaratively. */
export function definePlugin(p: RebasePlugin): RebasePlugin {
  return p
}

interface ActivePlugin {
  plugin: RebasePlugin
  disposers: (() => void)[]
}
const active = new Map<string, ActivePlugin>()

/** Activate plugins, wiring each contribution through a per-plugin disposer bag. */
export async function activatePlugins(plugins: RebasePlugin[], host: HostCapabilities): Promise<void> {
  for (const plugin of plugins) {
    if (active.has(plugin.id)) continue
    const disposers: (() => void)[] = []
    const track = (d: () => void) => disposers.push(d)
    const ctx: PluginContext = {
      id: plugin.id,
      host,
      registerCommand: (c) => track(registerCommand({ ...c, pluginId: plugin.id })),
      registerCommands: (cs) => track(registerCommands(cs.map((c) => ({ ...c, pluginId: plugin.id })))),
      registerStatusItem: (i) => track(registerStatusItem(i)),
      registerMenuItem: (c) => track(registerMenuItem(c)),
      registerView: (v) => track(registerView(v)),
      registerViewer: (v) => track(registerViewer(v)),
      registerKeybinding: (b) => track(registerKeybinding(b)),
    }
    active.set(plugin.id, { plugin, disposers })
    try {
      await plugin.activate(ctx)
    } catch (err) {
      // Isolate failures: one plugin throwing in activate() must not abort the
      // others (which would silently drop their views/menus/status items). Roll
      // back this plugin's partial contributions and carry on.
      console.error(`[plugins] failed to activate "${plugin.id}"`, err)
      disposers.forEach((d) => d())
      active.delete(plugin.id)
    }
  }
}

/** Tear down all active plugins (and their contributions). */
export function deactivatePlugins(): void {
  for (const { plugin, disposers } of active.values()) {
    try {
      plugin.deactivate?.()
    } catch {
      /* ignore */
    }
    disposers.forEach((d) => d())
  }
  active.clear()
}

export function activePluginIds(): string[] {
  return [...active.keys()]
}
