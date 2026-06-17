import type { RebasePlugin } from '@/services/plugins'
import notifications from './notifications'
import terminal from './terminal'
import projects from './projects'
import viewers from './viewers'
import crucible from './crucible'
// import demo from './demo'   ← uncomment to run the demo plugin

// To add a plugin: copy src/plugins/_template/, fill in your IDs, then import and add it below.
// Bundled first-party plugins, activated on startup. Comment one out to disable
// its surfaces (status item / view / menu items / file viewers) — a quick test
// of teardown.
export const bundledPlugins: RebasePlugin[] = [
  terminal,
  notifications,
  projects,
  viewers,
  crucible,
  // demo,   ← uncomment to run the demo plugin
]
