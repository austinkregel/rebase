<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { openShell, type ShellSession } from '@/services/ptyService'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const host = ref<HTMLElement | null>(null)
const status = ref<'idle' | 'connecting' | 'live' | 'closed' | 'error'>('idle')
const statusDetail = ref('')

let term: Terminal | null = null
let fit: FitAddon | null = null
let shell: ShellSession | null = null
let resizeObserver: ResizeObserver | null = null

async function start() {
  if (!session.activeClientId || !term || status.value === 'connecting' || status.value === 'live') return
  status.value = 'connecting'
  statusDetail.value = ''
  try {
    shell = await openShell(session.activeClientId)
    status.value = 'live'
    shell.onOutput((data) => term?.write(data))
    shell.onClosed((reason) => {
      status.value = 'closed'
      statusDetail.value = reason
      shell = null
      term?.write(`\r\n\x1b[2m[shell closed: ${reason}]\x1b[0m\r\n`)
    })
    fit?.fit()
    if (term) shell.resize(term.cols, term.rows)
    term.focus()
  } catch (err) {
    status.value = 'error'
    statusDetail.value = err instanceof Error ? err.message : String(err)
  }
}

function stop() {
  shell?.close()
  shell = null
  if (status.value === 'live') status.value = 'closed'
}

onMounted(() => {
  term = new Terminal({
    allowProposedApi: true,
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#0a0e14',
      foreground: '#d4dae2',
      cursor: '#7aa2f7',
      selectionBackground: '#1f3a5f',
    },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.open(host.value!)
  fit.fit()

  term.onData((data) => shell?.write(data))
  term.onResize(({ cols, rows }) => shell?.resize(cols, rows))

  resizeObserver = new ResizeObserver(() => fit?.fit())
  resizeObserver.observe(host.value!)
})

onBeforeUnmount(() => {
  stop()
  resizeObserver?.disconnect()
  term?.dispose()
  term = null
})

watch(
  () => session.activeClientId,
  () => {
    stop()
    term?.clear()
    status.value = 'idle'
  },
)
</script>

<template>
  <div class="terminal-pane">
    <div class="terminal-bar">
      <span class="terminal-title">terminal</span>
      <span v-if="status === 'live'" class="terminal-status live">● {{ session.activeClientId }}</span>
      <span v-else-if="status === 'connecting'" class="terminal-status">connecting…</span>
      <span v-else-if="status === 'error'" class="terminal-status error">{{ statusDetail }}</span>
      <span v-else-if="status === 'closed'" class="terminal-status">{{ statusDetail || 'closed' }}</span>
      <span class="terminal-spacer" />
      <button
        v-if="status !== 'live' && status !== 'connecting'"
        class="terminal-action"
        :disabled="!session.activeClientId"
        @click="start"
      >
        {{ status === 'idle' ? 'start shell' : 'restart shell' }}
      </button>
      <button v-else-if="status === 'live'" class="terminal-action" @click="stop">close</button>
    </div>
    <div ref="host" class="terminal-host" />
  </div>
</template>

<style scoped>
.terminal-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #0a0e14;
}
.terminal-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 11.5px;
}
.terminal-title {
  color: var(--fg-muted);
  letter-spacing: 0.06em;
}
.terminal-status {
  color: var(--fg-subtle);
}
.terminal-status.live {
  color: var(--green);
}
.terminal-status.error {
  color: var(--red);
}
.terminal-spacer {
  flex: 1;
}
.terminal-action {
  padding: 2px 10px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-muted);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.terminal-action:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}
.terminal-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.terminal-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px 0;
}
</style>
