import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { EventHandler, SocketStatus, StatusHandler, Transport } from './contract'

interface FramePayload {
  event: string
  data: Record<string, unknown>
}

interface ControlPlane {
  name: string
  url: string
}

/**
 * Transport backed by the Tauri Rust core. The webview never opens a socket:
 * it forwards `emit` to the `emit` command and receives inbound frames /
 * status as `cp://frame` / `cp://status` Tauri events. See
 * docs/DIRECT-MODE.md "IPC contract".
 */
export class TauriTransport implements Transport {
  status: SocketStatus = 'closed'

  private handlers = new Map<string, Set<EventHandler>>()
  private statusHandlers = new Set<StatusHandler>()
  private unlisten: UnlistenFn[] = []
  private wired = false
  /** Control plane to (re)connect to; defaults to the first configured one. */
  target: string | null = null

  setTarget(target: string): void {
    this.target = target
  }

  async connect(): Promise<void> {
    await this.wire()
    if (!this.target) {
      const cps = await invoke<ControlPlane[]>('list_control_planes').catch(() => [])
      this.target = cps[0]?.name ?? null
    }
    if (this.target) await invoke('connect', { controlPlane: this.target })
  }

  close(): void {
    void invoke('disconnect')
  }

  emit(event: string, data: Record<string, unknown> = {}): boolean {
    // Fire-and-forget into the Rust outbound queue; optimistically "sent".
    void invoke('emit', { event, data })
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

  private async wire(): Promise<void> {
    if (this.wired) return
    this.wired = true
    this.unlisten.push(
      await listen<FramePayload>('cp://frame', (e) => {
        this.dispatch(e.payload.event, e.payload.data ?? {})
      }),
    )
    this.unlisten.push(
      await listen<{ status: SocketStatus }>('cp://status', (e) => {
        this.status = e.payload.status
        for (const handler of [...this.statusHandlers]) handler(this.status)
      }),
    )
  }

  private dispatch(event: string, data: Record<string, unknown>): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of [...set]) handler(data)
  }
}
