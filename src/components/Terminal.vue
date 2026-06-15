<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import {
  ArrowPathIcon,
  ChevronDoubleDownIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/vue/20/solid'
import { openShell, type ShellSession } from '@/services/ptyService'
import { baseName } from '@/services/paths'
import { useSettingsStore } from '@/stores/settings'
import { openContextMenu, type ContextMenuItem } from '@/services/contextMenu'
import { menuItemsFor } from '@/services/menus'
import { notify } from '@/services/notifications'
import { dock } from '@/services/dock'
import { registerTerminal, updateTerminal, type TerminalStatus } from '@/services/terminals'
import Badge from '@/components/ui/Badge.vue'
import IconButton from '@/components/ui/IconButton.vue'
import TerminalSearchBar from '@/components/panels/TerminalSearchBar.vue'

// One xterm instance per terminal panel, bound to the server it was opened on
// (clientId comes from panel params, NOT the active agent — switching servers
// must not kill a running terminal). Auto-starts on mount; theme + font derive
// from the design tokens / editor settings.
const props = defineProps<{
  panelId: string
  clientId: string
  seq: number
  initialCwd?: string
  setTitle?: (title: string) => void
}>()

const settings = useSettingsStore()
const host = ref<HTMLElement | null>(null)
const status = ref<TerminalStatus>('connecting')
const statusDetail = ref('')
const showSearch = ref(false)
const atBottom = ref(true)

let term: Terminal | null = null
let fit: FitAddon | null = null
const searchAddon = new SearchAddon()
let shell: ShellSession | null = null
let resizeObserver: ResizeObserver | null = null
let fitTimer: ReturnType<typeof setTimeout> | null = null
let disposeEntry: (() => void) | undefined
let cdSent = false
let connecting = false
let startFallback: ReturnType<typeof setTimeout> | null = null

const fontSize = computed(() => settings.effective().fontSize)
// A terminal opened on a folder takes that folder's name; otherwise "Terminal N".
const baseTitle = computed(() =>
  props.initialCwd ? baseName(props.initialCwd) || `Terminal ${props.seq}` : `Terminal ${props.seq}`,
)
const dotClass = computed(
  () =>
    ({
      connecting: 'bg-yellow animate-pulse',
      live: 'bg-green',
      closed: statusDetail.value ? 'bg-red' : 'bg-subtle',
      error: 'bg-red',
    })[status.value],
)

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Tokyo-Night-aligned ANSI palette built from the app tokens, so the terminal
// matches the IDE and will follow a future theme toggle (re-call + term.refresh).
function buildTheme() {
  const bg = cssVar('--color-bg', '#0d1117')
  const fg = cssVar('--color-fg', '#d4dae2')
  const accent = cssVar('--color-accent', '#7aa2f7')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: accent + '33',
    selectionForeground: fg,
    black: cssVar('--color-hover', '#1a222d'),
    red: cssVar('--color-red', '#f7768e'),
    green: cssVar('--color-green', '#9ece6a'),
    yellow: cssVar('--color-yellow', '#e0af68'),
    blue: accent,
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: fg,
    brightBlack: cssVar('--color-subtle', '#5e6a76'),
    brightRed: '#ff899d',
    brightGreen: '#b9f27c',
    brightYellow: '#ff9e64',
    brightBlue: '#a9c1ff',
    brightMagenta: '#d4b8ff',
    brightCyan: '#a4daff',
    brightWhite: '#ffffff',
  }
}

// The tab title is cosmetic — never let a title update throw out of the mount
// hook or the start() path (a detached/stale setter would otherwise kill them).
function applyTitle(title: string) {
  try {
    props.setTitle?.(title)
  } catch {
    /* tab title is non-critical */
  }
}

function setStatus(next: TerminalStatus, detail = '') {
  status.value = next
  statusDetail.value = detail
  updateTerminal(props.panelId, { status: next, exitReason: detail || undefined })
  // Reflect exit/error state in the tab title (live keeps the base name).
  const base = baseTitle.value
  if (next === 'closed') applyTitle(detail ? `${base} [${detail}]` : `${base} [exited]`)
  else if (next === 'error') applyTitle(`${base} [error]`)
  else applyTitle(base)
}

async function start() {
  // Guard re-entrancy with a flag, not the status — the panel mounts in the
  // 'connecting' state, so a status check here would block the initial start.
  if (!term || connecting || status.value === 'live') return
  // A terminal restored from an old saved layout may have no bound server.
  if (!props.clientId) {
    setStatus('error', 'no server bound')
    term.write('\r\n\x1b[38;2;247;118;142m[no server bound to this terminal — open a new one]\x1b[0m\r\n')
    return
  }
  connecting = true
  setStatus('connecting')
  cdSent = false
  try {
    shell = await openShell(props.clientId)
    setStatus('live')
    shell.onOutput((data) => {
      term?.write(data)
      // Approximate "open in folder": cd once the shell is live (no PTY cwd).
      if (!cdSent && props.initialCwd) {
        cdSent = true
        shell?.write(`cd ${props.initialCwd}\r`)
      }
    })
    shell.onClosed((reason) => {
      shell = null
      const exited = /\b([1-9]\d*)\b/.test(reason) ? reason : ''
      setStatus('closed', exited)
      term?.write(
        exited
          ? `\r\n\x1b[38;2;247;118;142m[exited: ${reason}]\x1b[0m\r\n`
          : `\r\n\x1b[2m[exited]\x1b[0m\r\n`,
      )
    })
    fit?.fit()
    if (term) shell.resize(term.cols, term.rows)
    term.focus()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus('error', msg)
    term?.write(`\r\n\x1b[38;2;247;118;142m[error: ${msg}]\x1b[0m\r\n`)
    notify.error('Terminal failed to start', { source: 'Terminal', body: msg })
  } finally {
    connecting = false
  }
}

function kill() {
  shell?.close()
  shell = null
  if (status.value === 'live' || status.value === 'connecting') setStatus('closed')
}

function clear() {
  term?.clear()
  shell?.write('\x0c') // Ctrl-L: let the shell redraw its prompt
}

function scrollToBottom() {
  term?.scrollToBottom()
}

function toggleSearch() {
  showSearch.value = !showSearch.value
}

function onMenu(e: MouseEvent) {
  const items: ContextMenuItem[] = [
    {
      label: 'Copy',
      disabled: !term?.hasSelection(),
      action: () => {
        const sel = term?.getSelection()
        if (sel) void navigator.clipboard?.writeText(sel)
      },
    },
    {
      label: 'Paste',
      action: async () => {
        const text = await navigator.clipboard?.readText()
        if (text) shell?.write(text)
      },
    },
    { label: 'Select All', action: () => term?.selectAll() },
    { label: 'Clear', separator: true, disabled: status.value !== 'live', action: clear },
    { label: 'New Terminal', separator: true, action: () => dock.openTerminal?.({ clientId: props.clientId }) },
    ...menuItemsFor('terminal/context', { clientId: props.clientId, sessionId: shell?.session }),
  ]
  openContextMenu(e, items)
}

onMounted(() => {
  disposeEntry = registerTerminal({
    panelId: props.panelId,
    seq: props.seq,
    clientId: props.clientId,
    status: 'connecting',
    title: baseTitle.value,
  })
  // Adopt the terminal's name immediately (the panel opens titled "Terminal N";
  // a folder-opened terminal takes the folder name).
  applyTitle(baseTitle.value)

  term = new Terminal({
    allowProposedApi: true,
    fontFamily: cssVar('--font-mono', "ui-monospace, Menlo, Consolas, monospace"),
    fontSize: fontSize.value,
    cursorBlink: true,
    scrollback: 5000,
    theme: buildTheme(),
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.loadAddon(new Unicode11Addon())
  term.loadAddon(searchAddon)
  term.unicode.activeVersion = '11'
  term.open(host.value!)
  fit.fit()

  term.onData((data) => shell?.write(data))
  term.onResize(({ cols, rows }) => shell?.resize(cols, rows))
  term.onScroll(() => {
    const buf = term?.buffer.active
    atBottom.value = !buf || buf.viewportY >= buf.baseY
  })
  // Copy-on-select (xterm has no built-in option): copy the selection on mouse
  // release, the standard terminal-emulator behavior.
  host.value!.addEventListener('mouseup', () => {
    const sel = term?.getSelection()
    if (sel) void navigator.clipboard?.writeText(sel)
  })

  // Terminal-scoped shortcuts (only when xterm has focus, so they don't fight
  // the editor or readline): Cmd+F / Ctrl+Shift+F = find, Cmd+K / Ctrl+Shift+K
  // = clear. Plain Ctrl+F/Ctrl+K stay with the shell (forward-char / kill-line).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const mod = e.metaKey || (e.ctrlKey && e.shiftKey)
    if (mod && e.key.toLowerCase() === 'f') {
      showSearch.value = true
      return false
    }
    if (mod && e.key.toLowerCase() === 'k') {
      clear()
      return false
    }
    return true
  })

  // Auto-start once the panel is actually laid out. A dockview panel is often
  // 0×0 at mount; starting the PTY then sizes it 0 cols/rows and the prompt never
  // renders ("nothing happens"). The ResizeObserver fires when the panel gets real
  // dimensions — start there (with a timeout fallback so it always starts).
  let autoStarted = false
  const autoStart = () => {
    if (autoStarted) return
    autoStarted = true
    void start()
  }
  resizeObserver = new ResizeObserver(() => {
    if (fitTimer) clearTimeout(fitTimer)
    fitTimer = setTimeout(() => {
      fit?.fit()
      if ((host.value?.clientHeight ?? 0) > 0) autoStart()
    }, 16)
  })
  resizeObserver.observe(host.value!)
  startFallback = setTimeout(autoStart, 400)
})

onBeforeUnmount(() => {
  if (fitTimer) clearTimeout(fitTimer)
  if (startFallback) clearTimeout(startFallback)
  shell?.close()
  shell = null
  resizeObserver?.disconnect()
  term?.dispose()
  term = null
  disposeEntry?.()
})

// Live-apply editor font-size changes.
watch(fontSize, (size) => {
  if (!term) return
  term.options.fontSize = size
  fit?.fit()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-bg">
    <!-- Toolbar: status + bound server on the left, actions on the right. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
      <span class="size-1.5 shrink-0 rounded-full" :class="dotClass" />
      <Badge tone="neutral" class="max-w-[9rem]">
        <span class="truncate" :title="clientId">{{ clientId }}</span>
      </Badge>
      <span class="flex-1" />
      <IconButton :icon="MagnifyingGlassIcon" label="Find (⌘F)" @click="toggleSearch" />
      <IconButton
        v-show="!atBottom"
        :icon="ChevronDoubleDownIcon"
        label="Scroll to bottom"
        @click="scrollToBottom"
      />
      <IconButton v-if="status === 'live'" :icon="TrashIcon" label="Clear (⌘K)" @click="clear" />
      <IconButton
        v-if="status === 'closed' || status === 'error'"
        :icon="ArrowPathIcon"
        label="Restart shell"
        @click="start"
      />
      <IconButton
        v-if="status === 'live' || status === 'connecting'"
        :icon="XMarkIcon"
        label="Kill shell"
        @click="kill"
      />
    </div>

    <!-- Terminal surface (in-flow flex child, the layout xterm sizes cleanly
         against) + floating find widget overlaid in the relative wrapper. -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div ref="host" class="min-h-0 flex-1 px-2 pt-1" @contextmenu.prevent="onMenu" />
      <TerminalSearchBar
        v-if="showSearch"
        :search="searchAddon"
        class="absolute right-3.5 top-1.5 z-10"
        @close="showSearch = false"
      />
    </div>
  </div>
</template>
