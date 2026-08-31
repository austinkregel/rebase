import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rpc, RpcTimeoutError } from './rpc'
import type { Transport } from './contract'

/** Minimal in-memory Transport that lets a test drive inbound frames and inspect
 *  how many handlers are still subscribed per event (to catch listener leaks). */
function fakeSocket(emitReturns = true) {
  const handlers = new Map<string, Set<(d: Record<string, unknown>) => void>>()
  return {
    status: 'open' as const,
    emit: vi.fn(() => emitReturns),
    on: vi.fn((event: string, h: (d: Record<string, unknown>) => void) => {
      let set = handlers.get(event)
      if (!set) handlers.set(event, (set = new Set()))
      set.add(h)
      return () => set!.delete(h)
    }),
    off: vi.fn(),
    onStatus: vi.fn(() => () => {}),
    /** Deliver a frame to every subscriber of `event`. */
    inbound(event: string, data: Record<string, unknown>) {
      for (const h of [...(handlers.get(event) ?? [])]) h(data)
    },
    /** How many handlers are still registered for `event`. */
    count(event: string) {
      return handlers.get(event)?.size ?? 0
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('Rpc.call', () => {
  it('resolves with the matching response and unsubscribes', async () => {
    const sock = fakeSocket()
    const rpc = new Rpc(sock as unknown as Transport)
    const p = rpc.call('req', 'res', { requestId: 'r1', x: 1 })
    sock.inbound('res', { requestId: 'r1', ok: true })
    await expect(p).resolves.toEqual({ requestId: 'r1', ok: true })
    expect(sock.count('res')).toBe(0)
  })

  it('ignores frames whose requestId does not match', async () => {
    vi.useFakeTimers()
    const sock = fakeSocket()
    const rpc = new Rpc(sock as unknown as Transport)
    const p = rpc.call('req', 'res', { requestId: 'r1' }, { timeoutMs: 1000 })
    sock.inbound('res', { requestId: 'other', ok: true }) // not ours
    const assertion = expect(p).rejects.toBeInstanceOf(RpcTimeoutError)
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(sock.count('res')).toBe(0)
  })

  // Regression for the listener-leak / unhandled-rejection bug: on a failed emit
  // the pending subscription must be torn down and the promise rejected now — not
  // left to time out 20s later against a promise nobody holds.
  it('rejects immediately and leaves no listener when emit fails', async () => {
    const sock = fakeSocket(false)
    const rpc = new Rpc(sock as unknown as Transport)
    const p = rpc.call('req', 'res', { requestId: 'r1' })
    await expect(p).rejects.toThrow('Not connected to control plane')
    expect(sock.count('res')).toBe(0)
  })

  it('times out with RpcTimeoutError and unsubscribes', async () => {
    vi.useFakeTimers()
    const sock = fakeSocket()
    const rpc = new Rpc(sock as unknown as Transport)
    const p = rpc.call('req', 'res', { requestId: 'r1' }, { timeoutMs: 500 })
    const assertion = expect(p).rejects.toBeInstanceOf(RpcTimeoutError)
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(sock.count('res')).toBe(0)
  })
})

describe('Rpc.nextCancelable', () => {
  it('cancel() rejects the promise and unsubscribes', async () => {
    const sock = fakeSocket()
    const rpc = new Rpc(sock as unknown as Transport)
    const { promise, cancel } = rpc.nextCancelable('res', 'r1')
    expect(sock.count('res')).toBe(1)
    cancel(new Error('boom'))
    await expect(promise).rejects.toThrow('boom')
    expect(sock.count('res')).toBe(0)
  })

  it('resolves with the first matching frame', async () => {
    const sock = fakeSocket()
    const rpc = new Rpc(sock as unknown as Transport)
    const { promise } = rpc.nextCancelable('res', 'r1')
    sock.inbound('res', { requestId: 'r1', ok: true })
    await expect(promise).resolves.toEqual({ requestId: 'r1', ok: true })
  })
})
