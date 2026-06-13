import { markRaw } from 'vue'
import { BeakerIcon as BeakerOutline } from '@heroicons/vue/24/outline'
import { BeakerIcon } from '@heroicons/vue/20/solid'
import { definePlugin } from '@/services/plugins'
import type { FileMenuContext } from '@/services/menus'
import type { ContextMenuItem } from '@/services/contextMenu'
import { useProjectsStore } from '@/stores/projects'
import { useSessionStore } from '@/stores/session'
import { baseName, normalizeRoot } from '@/services/paths'
import ProjectsManager from '@/components/ProjectsManager.vue'

// The projects/workspaces feature as a bundled plugin: contributes the Project
// explorer view (column 2) and the "Add folder to a project" items on the file
// explorer's folder menu. The project/root row menus live inside ProjectsManager.
export default definePlugin({
  id: 'core.projects',
  name: 'Projects',
  activate(ctx) {
    ctx.registerView({
      id: 'projects',
      location: 'sidebar.project',
      title: 'Projects',
      icon: BeakerOutline,
      iconActive: BeakerIcon,
      order: 10,
      component: markRaw(ProjectsManager),
    })

    // Bridge from ad-hoc file browsing to the workspace: add a folder to any
    // project on this server, or seed a new project from it.
    ctx.registerMenuItem<FileMenuContext>({
      id: 'projects.addFolder',
      menu: 'folder/context',
      order: 50,
      build: (c) => {
        const projects = useProjectsStore()
        const session = useSessionStore()
        const root = normalizeRoot(c.path)
        const mine = projects.projects.filter((p) => p.clientId === c.clientId)
        const items: ContextMenuItem[] = mine.map((p) => ({
          label: `Add to "${p.name}"`,
          action: () => void projects.addRoot(p.id, c.path),
          disabled: p.rootPaths.includes(root),
        }))
        items.push({
          label: 'New Project from Folder',
          separator: mine.length > 0,
          action: async () => {
            const project = await projects.create({
              name: baseName(c.path) || 'project',
              controlPlane: session.selectedControlPlane?.name ?? null,
              clientId: c.clientId,
              rootPaths: [c.path],
            })
            projects.open(project.id)
          },
        })
        return items
      },
    })
  },
})
