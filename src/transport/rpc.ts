import type { Transport } from './contract'

export class RpcTimeoutError extends Error {
  constructor(event: string, ms: number) {
    super(`Timed out after ${ms}ms waiting for '${event}'`)
    this.name = 'RpcTimeoutError'
  }
}

export interface CallOptions {
  /** Milliseconds before the pending promise rejects. */
  timeoutMs?: number
  /** Narrow which response frames belong to this call (beyond requestId). */
  match?: (data: Record<string, unknown>) => boolean
}

const DEFAULT_TIMEOUT_MS = 20_000

export function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Request/response correlation over the event-based dashboard socket.
 *
 * The control plane has no acks: every request carries a client-generated
 * `requestId` and responses come back as separate events echoing it. Some
 * operations (file_put) emit SEVERAL responses for one requestId, so the
 * primitive here is a short-lived subscription (`expect`), with one-shot
 * `call` built on top of it.
 */
export class Rpc {
  constructor(private socket: Transport) {}

  /**
   * Subscribe to `responseEvent` frames whose `requestId` matches, until
   * `stop()` is called. Used for multi-response flows and streamed chunks.
   */
  expect(
    responseEvent: string,
    requestId: string,
    onFrame: (data: Record<string, unknown>) => void,
  ): () => void {
    return this.socket.on(responseEvent, (data) => {
      if (data.requestId !== requestId) return
      onFrame(data)
    })
  }

  /**
   * Emit `requestEvent` and resolve with the first matching `responseEvent`.
   */
  call<T = Record<string, unknown>>(
    requestEvent: string,
    responseEvent: string,
    data: Record<string, unknown> & { requestId: string },
    options: CallOptions = {},
  ): Promise<T> {
    const promise = this.next<T>(responseEvent, data.requestId, options)
    if (!this.socket.emit(requestEvent, data)) {
      return Promise.reject(new Error('Not connected to control plane'))
    }
    return promise
  }

  /**
   * Resolve with the next `responseEvent` frame matching `requestId`.
   * Subscribes immediately — call before emitting when the request was
   * already sent by other means.
   */
  next<T = Record<string, unknown>>(
    responseEvent: string,
    requestId: string,
    options: CallOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const stop = this.expect(responseEvent, requestId, (data) => {
        if (options.match && !options.match(data)) return
        cleanup()
        resolve(data as T)
      })
      const timer = setTimeout(() => {
        cleanup()
        reject(new RpcTimeoutError(responseEvent, timeoutMs))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        stop()
      }
    })
  }
}
