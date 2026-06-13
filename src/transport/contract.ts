export type SocketStatus = 'connecting' | 'open' | 'closed'

export type EventHandler = (data: Record<string, unknown>) => void
export type StatusHandler = (status: SocketStatus) => void

/**
 * The surface the rest of the app uses, regardless of whether frames travel
 * over a browser WebSocket (dev / PWA fallback) or the Tauri Rust core. Both
 * carry the same control-plane `{event, data}` protocol.
 */
export interface Transport {
  readonly status: SocketStatus
  /** Select which configured profile to connect to (Tauri only; no-op in browser). */
  setTarget?(target: string): void
  connect(): void | Promise<void>
  close(): void
  emit(event: string, data?: Record<string, unknown>): boolean
  on(event: string, handler: EventHandler): () => void
  off(event: string, handler: EventHandler): void
  onStatus(handler: StatusHandler): () => void
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
