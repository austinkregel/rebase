import { socket } from '@/transport/socket'
import type { ShellClosed, ShellError, ShellOutput, ShellStarted } from '@/transport/types'

export interface ShellSession {
  session: string
  clientId: string
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  onOutput(handler: (data: string) => void): () => void
  onClosed(handler: (reason: string) => void): () => void
}

const START_TIMEOUT_MS = 15_000

/**
 * `shell_start` carries no requestId — the server only echoes the `clientId` on
 * `shell_started`. With a single terminal that's enough, but multiple terminals
 * on the same server can't be told apart by clientId alone (the first opener
 * would steal the second's reply). So we keep a FIFO of pending opens per
 * clientId and pair each `shell_started` with the oldest pending open for that
 * clientId — assuming the server answers requests in order.
 */
interface PendingOpen {
  clientId: string
  resolve: (session: ShellSession) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingOpens: PendingOpen[] = []
let listenersInstalled = false

function settle(p: PendingOpen): void {
  clearTimeout(p.timer)
  const i = pendingOpens.indexOf(p)
  if (i !== -1) pendingOpens.splice(i, 1)
}

function installListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  socket.on('shell_started', (data) => {
    const started = data as unknown as ShellStarted
    const p = pendingOpens.find((x) => x.clientId === started.clientId)
    if (!p) {
      // No pending open — the opener already timed out and gave up, so this
      // server PTY is now orphaned. Tell the server to tear it down instead of
      // leaking a live shell nobody is attached to.
      console.debug(`[pty] orphaned shell_started session=${started.session} clientId=${started.clientId} (no pending open) — closing`)
      socket.emit('shell_close', { session: started.session })
      return
    }
    settle(p)
    console.debug(`[pty] shell_started session=${started.session} clientId=${started.clientId}`)
    p.resolve(makeSession(started))
  })
  socket.on('shell_error', (data) => {
    // shell_error carries no clientId/session, so we can't tell which agent
    // failed. Reject the MOST-RECENT pending open as the best available
    // heuristic (an error usually follows the request that just went out).
    // Proper fix needs a request id on `shell_start` — a protocol follow-up
    // (see docs/PROTOCOL.md).
    const message = (data as unknown as ShellError).message ?? 'shell error'
    console.warn(`[pty] shell_error: ${message}`)
    const p = pendingOpens[pendingOpens.length - 1]
    if (p) {
      settle(p)
      p.reject(new Error(message))
    }
  })
}

export function openShell(clientId: string): Promise<ShellSession> {
  installListeners()
  return new Promise((resolve, reject) => {
    console.debug(`[pty] → shell_start clientId=${clientId}`)
    if (!socket.emit('shell_start', { clientId })) {
      console.warn('[pty] shell_start not sent — socket not connected to control plane')
      reject(new Error('Not connected to control plane'))
      return
    }
    const p: PendingOpen = {
      clientId,
      resolve,
      reject,
      timer: setTimeout(() => {
        settle(p)
        console.warn(`[pty] shell_start timed out after ${START_TIMEOUT_MS}ms for clientId=${clientId} — no shell_started reply (is PTY deployed on that agent?)`)
        reject(new Error('Timed out waiting for shell_started'))
      }, START_TIMEOUT_MS),
    }
    pendingOpens.push(p)
  })
}

function makeSession({ session, clientId }: ShellStarted): ShellSession {
  const outputHandlers = new Set<(data: string) => void>()
  const closedHandlers = new Set<(reason: string) => void>()

  const stopOutput = socket.on('shell_output', (data) => {
    const frame = data as unknown as ShellOutput
    if (frame.session !== session) return
    for (const handler of outputHandlers) handler(frame.data)
  })
  const stopClosed = socket.on('shell_closed', (data) => {
    const frame = data as unknown as ShellClosed
    if (frame.session !== session) return
    teardown()
    for (const handler of closedHandlers) handler(frame.reason ?? 'closed')
  })

  const teardown = () => {
    stopOutput()
    stopClosed()
  }

  return {
    session,
    clientId,
    write(data) {
      socket.emit('shell_input', { session, data })
    },
    resize(cols, rows) {
      socket.emit('shell_resize', { session, cols, rows })
    },
    close() {
      socket.emit('shell_close', { session })
      teardown()
    },
    onOutput(handler) {
      outputHandlers.add(handler)
      return () => outputHandlers.delete(handler)
    },
    onClosed(handler) {
      closedHandlers.add(handler)
      return () => closedHandlers.delete(handler)
    },
  }
}
