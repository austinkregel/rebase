import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Dev-time requests to the control plane (/ws, /api, /auth) are proxied so the
// PWA and the server share an origin, exactly like production behind a reverse
// proxy. Point VITE_SERVER_URL at your control plane (default localhost:8443).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const server = env.VITE_SERVER_URL ?? 'http://localhost:8443'

  return {
    plugins: [
      vue(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'rebase',
          short_name: 'rebase',
          description: 'Thin-client IDE for your own infrastructure',
          theme_color: '#0d1117',
          background_color: '#0d1117',
          display: 'standalone',
          icons: [
            {
              src: 'icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          // App shell only — never cache the control-plane API or socket.
          navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/auth/],
          globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            codemirror: [
              '@codemirror/state',
              '@codemirror/view',
              '@codemirror/language',
              '@codemirror/commands',
              '@codemirror/autocomplete',
              '@codemirror/search',
            ],
            xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-unicode11'],
          },
        },
      },
    },
    // Tauri expects a fixed dev port (matches tauri.conf.json devUrl).
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/ws': { target: server, ws: true, changeOrigin: true },
        '/api': { target: server, changeOrigin: true },
        '/auth': { target: server, changeOrigin: true },
      },
    },
  }
})
