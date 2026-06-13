import type { RebasePlugin } from '@/services/plugins'
import notifications from './notifications'
import terminal from './terminal'
import projects from './projects'
import viewers from './viewers'

// Bundled first-party plugins, activated on startup. Comment one out to disable
// its surfaces (status item / view / menu items / file viewers) — a quick test
// of teardown.
export const bundledPlugins: RebasePlugin[] = [terminal, notifications, projects, viewers]
