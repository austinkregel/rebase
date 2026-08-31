import { describe, expect, it, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  stat: vi.fn(),
  readBytes: vi.fn(),
}))

vi.mock('@/services/fileService', () => ({
  FileOpError: class extends Error {},
  fileService: { stat: h.stat, readBytes: h.readBytes },
}))

import { sniff, resolveOpen, readTextForAgent, FILE_LIMITS } from './fileContent'
import type { DirListEntry } from '@/transport/types'

const enc = new TextEncoder()

beforeEach(() => {
  h.stat.mockReset()
  h.readBytes.mockReset()
})

describe('sniff', () => {
  it('empty file is editable text', () => {
    expect(sniff(new Uint8Array())).toMatchObject({ kind: 'empty', cleanUtf8: true })
  })

  it('pure ASCII is clean text', () => {
    expect(sniff(enc.encode('hello world\n'))).toMatchObject({ kind: 'text', cleanUtf8: true })
  })

  it('valid UTF-8 with accents/emoji is clean text (editable)', () => {
    expect(sniff(enc.encode('café — 🚀 façade'))).toMatchObject({ kind: 'text', cleanUtf8: true })
  })

  it('a NUL byte marks binary', () => {
    expect(sniff(new Uint8Array([0x68, 0x00, 0x69]))).toMatchObject({ kind: 'binary', cleanUtf8: false })
  })

  it('a high control-byte ratio marks binary', () => {
    expect(sniff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toMatchObject({ kind: 'binary' })
  })

  it('UTF-16 BOM is text but not clean UTF-8 (read-only)', () => {
    expect(sniff(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toMatchObject({
      kind: 'text',
      cleanUtf8: false,
      encoding: 'utf-16',
    })
  })

  it('lossy bytes (lone 0xff) are not clean UTF-8', () => {
    expect(sniff(new Uint8Array([0x68, 0x69, 0xff, 0x0a]))).toMatchObject({ cleanUtf8: false })
  })

  it('a multibyte sequence straddling the buffer end is not misjudged binary', () => {
    // "é" is 0xC3 0xA9; drop the trailing continuation byte to simulate a cut.
    const cut = enc.encode('donné').subarray(0, enc.encode('donné').length - 1)
    expect(sniff(cut)).toMatchObject({ kind: 'text', cleanUtf8: true })
  })
})

const entry = (over: Partial<DirListEntry>): DirListEntry => ({ name: 'f', type: 'file', ...over })

describe('resolveOpen', () => {
  it('classifies a directory without reading', async () => {
    const { plan } = await resolveOpen('c1', '/dir', entry({ type: 'dir' }))
    expect(plan.kind).toBe('directory')
    expect(h.readBytes).not.toHaveBeenCalled()
  })

  it('classifies a socket/device/fifo as special without reading', async () => {
    const { plan } = await resolveOpen('c1', '/run/x.sock', entry({ mode: 'srwxr-xr-x' }))
    expect(plan).toMatchObject({ kind: 'special', special: 'socket', editable: false })
    expect(h.readBytes).not.toHaveBeenCalled()
  })

  it('an octet-stream file that sniffs as text is editable text', async () => {
    h.readBytes.mockResolvedValue(enc.encode('const x = 1\n'))
    const { plan, content } = await resolveOpen('c1', '/src/thing', entry({ size: 12 }))
    expect(plan).toMatchObject({ kind: 'text', editable: true })
    expect(content).toBe('const x = 1\n')
  })

  it('a binary file is read-only hex with no decoded content', async () => {
    h.readBytes.mockResolvedValue(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
    const { plan, content } = await resolveOpen('c1', '/bin/a.out', entry({ size: 6 }))
    expect(plan).toMatchObject({ kind: 'binary-hex', editable: false })
    expect(content).toBeUndefined()
  })

  it('an oversized file is too-large and never read', async () => {
    const { plan } = await resolveOpen('c1', '/huge.log', entry({ size: FILE_LIMITS.editableMaxBytes + 1 }))
    expect(plan).toMatchObject({ kind: 'too-large', editable: false })
    expect(h.readBytes).not.toHaveBeenCalled()
  })

  it('uses a known entry instead of a stat round-trip', async () => {
    h.readBytes.mockResolvedValue(enc.encode('hi'))
    await resolveOpen('c1', '/a.txt', entry({ size: 2 }))
    expect(h.stat).not.toHaveBeenCalled()
  })
})

describe('readTextForAgent', () => {
  it('returns text for clean text files', async () => {
    h.readBytes.mockResolvedValue(enc.encode('print(1)'))
    await expect(readTextForAgent('c1', '/a.py')).resolves.toMatchObject({ text: 'print(1)', binary: false })
  })

  it('returns binary:true and no text for binary files', async () => {
    h.readBytes.mockResolvedValue(new Uint8Array([0, 1, 2, 3]))
    await expect(readTextForAgent('c1', '/a.bin')).resolves.toMatchObject({ text: '', binary: true })
  })
})
