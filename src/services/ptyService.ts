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
 * PTY sessions over the dashboard socket. `shell_start` has no requestId —
 * the server assigns a session UUID and replies with `shell_started`, so we
 * pair the next started-frame for our clientId with this request.
 */
export function openShell(clientId: string): Promise<ShellSession> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for shell_started'))
    }, START_TIMEOUT_MS)

    const stopStarted = socket.on('shell_started', (data) => {
      const started = data as unknown as ShellStarted
      if (started.clientId !== clientId) return
      cleanup()
      resolve(makeSession(started))
    })
    const stopError = socket.on('shell_error', (data) => {
      cleanup()
      reject(new Error((data as unknown as ShellError).message ?? 'shell error'))
    })
    const cleanup = () => {
      clearTimeout(timer)
      stopStarted()
      stopError()
    }

    if (!socket.emit('shell_start', { clientId })) {
      cleanup()
      reject(new Error('Not connected to control plane'))
    }
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
