import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'
import 'dockview-vue/dist/styles/dockview.css'

createApp(App).use(createPinia()).mount('#app')

// Dev-only: expose stores on window for debugging and headless render checks.
if (import.meta.env.DEV) {
  Promise.all([
    import('@/stores/session'),
    import('@/stores/agents'),
    import('@/stores/files'),
  ]).then(([s, a, f]) => {
    ;(window as Window & { __rebase?: unknown }).__rebase = {
      session: s.useSessionStore(),
      agents: a.useAgentsStore(),
      files: f.useFilesStore(),
    }
  })
}
