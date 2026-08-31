import { describe, expect, it, beforeEach, vi } from 'vitest'

// Drive the transport by hand: capture the last emitted requestId and let tests
// deliver inbound frames, and let a test force a chunk emit to fail mid-stream.
const h = vi.hoisted(() => ({
  inbound: new Map<string, Set<(d: Record<string, unknown>) => void>>(),
  state: { lastRequestId: '', emitOk: (_event: string) => true, lastPayload: {} as Record<string, unknown> },
}))

vi.mock('@/transport/socket', () => ({
  socket: {
    status: 'open',
    emit: (event: string, data: Record<string, unknown>) => {
      if (typeof data?.requestId === 'string') h.state.lastRequestId = data.requestId
      if (event === 'file_get_request') h.state.lastPayload = data
      return h.state.emitOk(event)
    },
    on: (event: string, cb: (d: Record<string, unknown>) => void) => {
      let set = h.inbound.get(event)
      if (!set) h.inbound.set(event, (set = new Set()))
      set.add(cb)
      return () => set!.delete(cb)
    },
    off: () => {},
    onStatus: () => () => {},
  },
}))

import { fileService, writeTimeoutFor } from './fileService'

/** Deliver a frame to current subscribers, stamped with the live requestId. */
function respond(event: string, data: Record<string, unknown> = {}) {
  for (const cb of [...(h.inbound.get(event) ?? [])]) {
    cb({ requestId: h.state.lastRequestId, ...data })
  }
}

/** base64 of n zero bytes → decodes back to n bytes (for cap tests). */
function b64Bytes(n: number): string {
  return btoa(String.fromCharCode(...new Array(n).fill(0)))
}

beforeEach(() => {
  h.inbound.clear()
  h.state.lastRequestId = ''
  h.state.emitOk = () => true
})

describe('writeTimeoutFor', () => {
  it('scales the upload deadline with size on top of a floor', () => {
    const small = writeTimeoutFor(0)
    const large = writeTimeoutFor(500 * 1024 * 1024)
    expect(small).toBeGreaterThanOrEqual(30_000)
    expect(large).toBeGreaterThan(small)
    expect(large).toBeGreaterThan(60_000)
  })
})

describe('writeBytes', () => {
  it('rejects cleanly when a chunk emit fails mid-stream (no unhandled rejection)', async () => {
    // Start + finish sends succeed; the chunk send fails.
    h.state.emitOk = (event) => event !== 'file_put_chunk'
    const p = fileService.writeBytes('c1', '/a.bin', new Uint8Array([1, 2, 3]))
    // Ack the start so writeBytes proceeds to stream chunks.
    respond('file_put_result', { ok: true })
    await expect(p).rejects.toThrow(/connection lost mid-upload/)
  })
})

describe('readBytes', () => {
  it('aborts as soon as streamed chunks exceed maxBytes, before the result frame', async () => {
    const p = fileService.readBytes('c1', '/big.bin', 10)
    // Two 8-byte chunks = 16 bytes > the 10-byte cap → abort during accumulation.
    respond('file_get_chunk', { offset: 0, data: b64Bytes(8) })
    respond('file_get_chunk', { offset: 8, data: b64Bytes(8) })
    // Note: no file_get_result is ever sent; the cap must reject on its own.
    await expect(p).rejects.toThrow(/too large/)
  })

  it('reassembles ordered chunks under the cap', async () => {
    const p = fileService.readBytes('c1', '/ok.bin', 1024)
    respond('file_get_chunk', { offset: 0, data: b64Bytes(3) })
    respond('file_get_result', { ok: true, size: 3 })
    await expect(p).resolves.toEqual(new Uint8Array([0, 0, 0]))
  })
})

describe('readRange', () => {
  it('sends offset/length and returns the window metadata', async () => {
    const p = fileService.readRange('c1', '/big.log', 100, 50)
    expect(h.state.lastPayload).toMatchObject({ path: '/big.log', offset: 100, length: 50 })
    respond('file_get_chunk', { offset: 100, data: b64Bytes(50) })
    respond('file_get_result', { ok: true, size: 1000, offset: 100, returned: 50, eof: false, truncated: false })
    const r = await p
    expect(r).toMatchObject({ offset: 100, size: 1000, eof: false, truncated: false })
    expect(r.bytes.length).toBe(50)
  })

  it('rejects loudly when an old agent ignores the range and streams from 0', async () => {
    const p = fileService.readRange('c1', '/big.log', 100, 50)
    // Old agent: streams from offset 0 and returns none of the ranged-read fields.
    respond('file_get_chunk', { offset: 0, data: b64Bytes(50) })
    respond('file_get_result', { ok: true, size: 1000 })
    await expect(p).rejects.toThrow(/lacks ranged file_get|whole file instead/)
  })

  it('an explicit ok:false range rejection surfaces the agent error', async () => {
    const p = fileService.readRange('c1', '/big.log', 0, 50)
    respond('file_get_result', { ok: false, error: 'ranged reads unsupported' })
    await expect(p).rejects.toThrow(/ranged reads unsupported/)
  })
})
