import { beforeEach, describe, expect, it, vi } from 'vitest'

// Routed by command name so one mock serves both the model probe and the cache
// commands `cacheGet`/`cacheSet` issue underneath.
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const isTauri = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/transport/contract', () => ({ isTauri }))

import { _resetCacheMemo } from '@/services/context/cacheStore'
import {
  FALLBACK_NUM_CTX,
  MAX_NUM_CTX,
  MIN_NUM_CTX,
  modelInfo,
  resolveNumCtx,
} from './modelLimits'

interface ShowResult {
  contextWindow: number | null
  pinned: boolean
  family: string | null
  parameterSize: string | null
}

/** Make `ollama_model_info` answer with `info`; cache reads always miss. */
function withModelInfo(info: Partial<ShowResult> | Error) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'cache_get') return Promise.resolve(null)
    if (cmd === 'cache_set') return Promise.resolve()
    if (cmd === 'ollama_model_info') {
      return info instanceof Error
        ? Promise.reject(info)
        : Promise.resolve({ contextWindow: null, pinned: false, family: null, parameterSize: null, ...info })
    }
    return Promise.reject(new Error(`unexpected command ${cmd}`))
  })
}

beforeEach(() => {
  _resetCacheMemo()
  invoke.mockReset()
  isTauri.mockReturnValue(true)
})

describe('resolveNumCtx — discovery', () => {
  it('uses a discovered window that is already within the cap', async () => {
    withModelInfo({ contextWindow: 8192 })
    await expect(resolveNumCtx('http://x', 'qwen2.5-coder')).resolves.toBe(8192)
  })

  it('caps a huge trained window', async () => {
    // The regression this cap exists for: llama3.1's 131072 would have Ollama
    // allocate ~16 GiB of KV cache for a 4.7 GB model, forcing CPU offload.
    withModelInfo({ contextWindow: 131072 })
    await expect(resolveNumCtx('http://x', 'llama3.1:8b')).resolves.toBe(MAX_NUM_CTX)

    withModelInfo({ contextWindow: 262144 })
    await expect(resolveNumCtx('http://x', 'qwen3')).resolves.toBe(MAX_NUM_CTX)
  })

  it('floors a tiny trained window', async () => {
    withModelInfo({ contextWindow: 1024 })
    await expect(resolveNumCtx('http://x', 'tiny')).resolves.toBe(MIN_NUM_CTX)
  })

  it('honours a pinned modelfile value exactly, in both directions', async () => {
    // A pin is the operator's statement about their own hardware. Raising it
    // wastes memory they said they don't have; capping it truncates below intent.
    withModelInfo({ contextWindow: 2048, pinned: true })
    await expect(resolveNumCtx('http://x', 'pinned-small')).resolves.toBe(2048)

    withModelInfo({ contextWindow: 65536, pinned: true })
    await expect(resolveNumCtx('http://x', 'pinned-large')).resolves.toBe(65536)
  })

  it('falls back when Ollama rejects, and does not throw', async () => {
    withModelInfo(new Error('connection refused'))
    await expect(resolveNumCtx('http://x', 'm')).resolves.toBe(FALLBACK_NUM_CTX)
  })

  it('serves a second call from the memo without probing again', async () => {
    withModelInfo({ contextWindow: 8192 })
    await resolveNumCtx('http://x', 'm')
    await resolveNumCtx('http://x', 'm')

    const probes = invoke.mock.calls.filter(([cmd]) => cmd === 'ollama_model_info')
    expect(probes).toHaveLength(1)
  })

  it('writes the discovered info through to the disk cache', async () => {
    withModelInfo({ contextWindow: 8192 })
    await modelInfo('http://x', 'm')

    const writes = invoke.mock.calls.filter(([cmd]) => cmd === 'cache_set')
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toMatchObject({ namespace: 'ollama-models' })
  })
})

describe('resolveNumCtx — the override is a ceiling, not a value', () => {
  it('lowers the cap below the default', async () => {
    withModelInfo({ contextWindow: 131072 })
    await expect(resolveNumCtx('http://x', 'm', 8192)).resolves.toBe(8192)
  })

  it('raises the cap for someone with the memory to spare', async () => {
    withModelInfo({ contextWindow: 131072 })
    await expect(resolveNumCtx('http://x', 'm', 65536)).resolves.toBe(65536)
  })

  it('never invents capacity the model does not have', async () => {
    withModelInfo({ contextWindow: 8192 })
    await expect(resolveNumCtx('http://x', 'm', 65536)).resolves.toBe(8192)
  })

  it('ignores an override below the floor', async () => {
    // 512 tokens cannot hold the system prefix, let alone context.
    withModelInfo({ contextWindow: 131072 })
    await expect(resolveNumCtx('http://x', 'm', 512)).resolves.toBe(MAX_NUM_CTX)
  })

  it('floors a fractional override', async () => {
    withModelInfo({ contextWindow: 131072 })
    await expect(resolveNumCtx('http://x', 'm', 8192.7)).resolves.toBe(8192)
  })

  it('does not override a pinned modelfile value', async () => {
    withModelInfo({ contextWindow: 2048, pinned: true })
    await expect(resolveNumCtx('http://x', 'm', 32768)).resolves.toBe(2048)
  })
})

describe('resolveNumCtx — without a Tauri core', () => {
  // The browser build, and equally the "Ollama is unreachable" path.
  beforeEach(() => isTauri.mockReturnValue(false))

  it('falls back conservatively rather than guessing high', async () => {
    await expect(resolveNumCtx('http://localhost:11434', 'qwen2.5-coder')).resolves.toBe(
      FALLBACK_NUM_CTX,
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('still respects an override that lowers the ceiling', async () => {
    await expect(resolveNumCtx('http://x', 'm', 4096)).resolves.toBe(4096)
  })
})
