import type { Envelope } from './types'
import {
  isTauri,
  type EventHandler,
  type SocketStatus,
  type StatusHandler,
  type Transport,
} from './contract'
import { TauriTransport } from './tauri'

export type { SocketStatus } from './contract'

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 15_000

/**
 * Connection to the control plane's /ws/dashboard endpoint, used in the browser
 * (dev and PWA fallback). In the desktop app the Rust core owns the socket and
 * {@link TauriTransport} is used instead.
 *
 * Plain WebSocket carrying `{ event, data }` JSON frames (NOT Socket.IO).
 * Reconnects forever with capped exponential backoff and answers the server's
 * keepalive pings.
 */
export class ControlPlaneSocket implements Transport {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<EventHandler>>()
  private statusHandlers = new Set<StatusHandler>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false

  status: SocketStatus = 'closed'

  constructor(private url: string = defaultDashboardUrl()) {}

  connect(): void {
    this.closedByUser = false
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.setStatus('connecting')
    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.setStatus('open')
    }

    ws.onmessage = (msg: MessageEvent) => {
      let envelope: Envelope
      try {
        envelope = JSON.parse(String(msg.data))
      } catch {
        return
      }
      if (!envelope || typeof envelope.event !== 'string') return
      const data = envelope.data ?? {}
      if (envelope.event === 'ping') {
        this.emit('pong', { ts: Date.now() })
        return
      }
      this.dispatch(envelope.event, data)
    }

    ws.onclose = () => {
      // A superseded socket (one we already replaced) must not stomp the current
      // socket's status or arm a reconnect — only the live socket's close counts.
      if (this.ws === ws) {
        this.ws = null
        this.setStatus('closed')
        if (!this.closedByUser) this.scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    }
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  emit(event: string, data: Record<string, unknown> = {}): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify({ event, data } satisfies Envelope))
    return true
  }

  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => this.off(event, handler)
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    handler(this.status)
    return () => this.statusHandlers.delete(handler)
  }

  private dispatch(event: string, data: Record<string, unknown>): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of [...set]) handler(data)
  }

  private setStatus(status: SocketStatus): void {
    this.status = status
    for (const handler of [...this.statusHandlers]) handler(status)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempt, BACKOFF_MAX_MS)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

export function defaultDashboardUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/dashboard`
}

/**
 * Single shared transport for the app. In the desktop app the Rust core owns
 * the connection (TLS, cert pinning, OIDC); in the browser we talk WebSocket
 * directly. Services import this and never learn which one they got.
 */
export const socket: Transport = isTauri() ? new TauriTransport() : new ControlPlaneSocket()
