import { socket } from '@/transport/socket'
import { Rpc, RpcTimeoutError, newRequestId } from '@/transport/rpc'
import { base64ToBytes, bytesToBase64, decodeText, encodeText } from '@/transport/encoding'
import { baseName, parentDir } from '@/services/paths'
import type {
  DirListEntry,
  DirListResponse,
  FileChmodResult,
  FileDeleteResult,
  FileGetChunk,
  FileGetResult,
  ExecResult,
  FileMkdirResult,
  FilePutResult,
  FileRenameResult,
  ReadRange,
} from '@/transport/types'

export class FileOpError extends Error {
  constructor(op: string, path: string, detail: string) {
    super(`${op} ${path}: ${detail}`)
    this.name = 'FileOpError'
  }
}

/** Raw chunk size for uploads/downloads; well under the 1 MB frame limit. */
const CHUNK_BYTES = 256 * 1024
const LIST_TIMEOUT_MS = 20_000
const READ_TIMEOUT_MS = 30_000
/** Ceiling for binary viewer reads — the whole file buffers in memory to build
 *  a Blob URL, and the agent rejects a whole-file read over its 32 MiB
 *  fileGetMaxBytes limit, so cap at that. Text reads are capped separately. */
const MAX_BINARY_BYTES = 32 * 1024 * 1024
/** Upload result timeout: the single deadline must cover streaming every chunk,
 *  the agent's disk write, and the finish round-trip — so scale it with size on
 *  top of a floor, instead of the fixed 20s that fails large uploads. */
const WRITE_TIMEOUT_BASE_MS = 30_000
/** Assumed floor throughput for sizing the upload timeout (~1 MB/s). */
const WRITE_MIN_BYTES_PER_MS = 1024

export function writeTimeoutFor(byteLength: number): number {
  return WRITE_TIMEOUT_BASE_MS + Math.ceil(byteLength / WRITE_MIN_BYTES_PER_MS)
}

/** Default ceiling for text reads — source files are small; this only guards
 *  against buffering a pathologically large file into a string. */
const MAX_TEXT_BYTES = 25 * 1024 * 1024

/** Decoded byte length of a standard (newline-free) base64 string, without
 *  decoding it — used to enforce the read cap as chunks stream in. */
function base64DecodedLength(b64: string): number {
  const len = b64.length
  if (len === 0) return 0
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/**
 * The async filesystem interface the rest of the app uses. Every wire-format
 * assumption stays behind this adapter (see docs/PROTOCOL.md).
 */
export class FileService {
  private rpc = new Rpc(socket)

  /** List a directory on the given agent. */
  async list(clientId: string, path: string): Promise<DirListEntry[]> {
    const response = await this.rpc.call<DirListResponse>(
      'dir_list_request',
      'dir_list_response',
      { clientId, requestId: newRequestId(), mode: 'local', path },
      { timeoutMs: LIST_TIMEOUT_MS },
    )
    if (response.error) throw new FileOpError('list', path, response.error)
    return response.entries ?? []
  }

  /**
   * Run an allowlisted command on the agent and return its output. Generic
   * primitive — git status, build, test, lint, … are client-side helpers over
   * this. `cwd` (when set) is confined to the agent's allowed roots.
   */
  async exec(
    clientId: string,
    command: string,
    cwd?: string,
    opts?: { timeoutSec?: number; timeoutMs?: number },
  ): Promise<ExecResult> {
    return this.execCancellable(clientId, command, cwd, opts).result
  }

  /**
   * Like `exec`, but returns a `cancel()` that kills the running command on the
   * agent (via `exec_cancel`) without dropping the control-plane socket — used by
   * the Crucible agent loop's Stop.
   */
  execCancellable(
    clientId: string,
    command: string,
    cwd?: string,
    opts?: { timeoutSec?: number; timeoutMs?: number },
  ): { result: Promise<ExecResult>; cancel: () => void } {
    const requestId = newRequestId()
    const result = this.rpc.call<ExecResult>(
      'exec_request',
      'exec_result',
      {
        clientId,
        requestId,
        command,
        cwd: cwd ?? '',
        ...(opts?.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
      },
      { timeoutMs: opts?.timeoutMs ?? LIST_TIMEOUT_MS },
    )
    const cancel = () => {
      socket.emit('exec_cancel', { clientId, requestId })
    }
    return { result, cancel }
  }

  /** Stat by listing the parent — the protocol has no dedicated stat. */
  async stat(clientId: string, path: string): Promise<DirListEntry | null> {
    // OS-aware parent/name split (the agent's paths may be Windows-style, and a
    // trailing slash must not yield an empty name).
    const parent = parentDir(path)
    const name = baseName(path)
    const entries = await this.list(clientId, parent)
    return entries.find((e) => e.name === name) ?? null
  }

  /**
   * Read file content as text. Implements the proposed `file_get` extension
   * (docs/PROTOCOL.md "PROTOCOL GAP") — fails with a clear error until the
   * server and agent support it.
   */
  async read(clientId: string, path: string): Promise<string> {
    return decodeText((await this.fetchBytes(clientId, path, MAX_TEXT_BYTES)).bytes)
  }

  /**
   * Read a byte window `[offset, offset+length)` of a file. Requires an agent
   * that implements ranged file_get (advertised in `stats.capabilities`, e.g. a
   * "file" capability listing a "range" feature) — callers should gate on
   * `useAgentsStore().supports(...)`/`capabilityFeatures(...)` first. This method
   * additionally rejects loudly if the agent turns out to have ignored the range
   * (streamed the whole file) rather than silently returning wrong data. The
   * ranged wire contract is docs/PROTOCOL-RANGED-IO.md.
   */
  async readRange(
    clientId: string,
    path: string,
    offset: number,
    length: number,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<ReadRange> {
    const { bytes, result } = await this.fetchBytes(clientId, path, length, timeoutMs, { offset, length })
    // A new agent that explicitly rejects a range returns ok:false — already
    // surfaced loudly by fetchBytes. An OLD agent silently ignores the unknown
    // offset/length and streams the whole file from 0, returning none of the
    // ranged-read result fields; detect that and fail loud rather than hand back
    // the wrong bytes as if they were the window.
    const hasRangeFields = result.offset != null || result.returned != null || result.eof != null
    if (offset > 0 && !hasRangeFields) {
      throw new FileOpError(
        'read',
        path,
        `agent "${clientId}" streamed the whole file instead of the requested byte range — its compute-agent lacks ranged file_get (offset/length); redeploy the agent on that server`,
      )
    }
    return {
      bytes,
      offset: result.offset ?? offset,
      size: result.size ?? -1,
      eof: result.eof ?? true,
      truncated: result.truncated ?? false,
    }
  }

  /**
   * Read raw file bytes (no UTF-8 decode) — the path the content-aware viewers
   * (images, PDF, audio/video, zip) use. The wire format already carries bytes;
   * only `read()` text-decodes them. `maxBytes` guards against buffering an
   * unbounded blob in memory (the whole file is held to build a Blob URL).
   */
  async readBytes(
    clientId: string,
    path: string,
    maxBytes = MAX_BINARY_BYTES,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    return (await this.fetchBytes(clientId, path, maxBytes, timeoutMs)).bytes
  }

  /** Stream the chunked `file_get` download and reassemble the raw bytes. When
   *  `range` is set (ranged read), `offset`/`length` are sent on the request and
   *  the terminal result is returned so the caller can read the range metadata. */
  private async fetchBytes(
    clientId: string,
    path: string,
    maxBytes?: number,
    timeoutMs = READ_TIMEOUT_MS,
    range?: { offset: number; length?: number },
  ): Promise<{ bytes: Uint8Array; result: FileGetResult }> {
    const requestId = newRequestId()
    const chunks: FileGetChunk[] = []
    const tooLarge = (size: number) =>
      new FileOpError(
        'read',
        path,
        `file is ${formatBytes(size)} — too large to open here (limit ${formatBytes(maxBytes ?? 0)})`,
      )

    // Subscribe for the terminal result with a cancel handle so the chunk
    // handler can abort the moment the running total exceeds maxBytes — the
    // point of the cap is to NOT buffer an unbounded blob, so it must fire
    // during accumulation, not after the whole file is in memory.
    const { promise: resultPromise, cancel: cancelResult } =
      this.rpc.nextCancelable<FileGetResult>('file_get_result', requestId, { timeoutMs })

    let received = 0
    const stopChunks = this.rpc.expect('file_get_chunk', requestId, (data) => {
      const chunk = data as unknown as FileGetChunk
      chunks.push(chunk)
      if (maxBytes != null) {
        received += base64DecodedLength(chunk.data)
        if (received > maxBytes) cancelResult(tooLarge(received))
      }
    })
    // The control plane emits `file_get_dispatched` the instant it forwards the
    // request to the agent. Tracking it lets a timeout pinpoint the stale hop:
    // no dispatch → the control plane doesn't route file_get; dispatched but no
    // result → the agent on that server doesn't handle it.
    let dispatched = false
    const stopDispatched = this.rpc.expect('file_get_dispatched', requestId, () => {
      dispatched = true
    })
    if (
      !socket.emit('file_get_request', {
        clientId,
        requestId,
        path,
        ...(maxBytes != null ? { maxSize: maxBytes } : {}),
        ...(range ? { offset: range.offset, ...(range.length != null ? { length: range.length } : {}) } : {}),
      })
    ) {
      cancelResult(new Error('Not connected to control plane'))
    }
    let result: FileGetResult
    try {
      result = await resultPromise
      if (!result.ok) throw new FileOpError('read', path, result.error ?? 'unknown error')
      // A non-ranged read caps on the total file size; a ranged read is bounded
      // by its window, so only guard the whole-file case here.
      if (!range && maxBytes != null && result.size != null && result.size > maxBytes) {
        throw tooLarge(result.size)
      }
    } catch (err) {
      if (err instanceof RpcTimeoutError) {
        throw new FileOpError(
          'read',
          path,
          dispatched
            ? `agent "${clientId}" did not respond — its compute-agent binary likely lacks file_get (redeploy the agent on that server)`
            : 'control plane did not route file_get — redeploy compute-agent-server on the control-plane host',
        )
      }
      throw err
    } finally {
      stopChunks()
      stopDispatched()
    }

    chunks.sort((a, b) => a.offset - b.offset)
    const parts = chunks.map((c) => base64ToBytes(c.data))
    const total = parts.reduce((n, p) => n + p.length, 0)
    const bytes = new Uint8Array(total)
    let pos = 0
    for (const part of parts) {
      bytes.set(part, pos)
      pos += part.length
    }
    return { bytes, result }
  }

  /**
   * Write file content via the chunked upload flow. The agent sends
   * `file_put_result` after start (accept/reject), on chunk failure, and
   * after finish — each step waits for its own result frame.
   */
  async write(clientId: string, path: string, content: string): Promise<void> {
    await this.writeBytes(clientId, path, encodeText(content))
  }

  /** Write raw bytes (e.g. an uploaded binary) via the chunked upload flow, with
   *  an optional unix mode string ("0755") applied on creation. `timeoutMs`
   *  defaults to a size-scaled budget covering the whole stream + write + finish. */
  async writeBytes(
    clientId: string,
    path: string,
    bytes: Uint8Array,
    mode?: string,
    timeoutMs = writeTimeoutFor(bytes.length),
  ): Promise<void> {
    const requestId = newRequestId()

    const started = await this.rpc.call<FilePutResult>('file_put_start', 'file_put_result', {
      clientId,
      requestId,
      path,
      size: bytes.length,
      overwrite: true,
      force: false,
      ...(mode ? { mode } : {}),
    })
    if (!started.ok) throw new FileOpError('write', path, started.error ?? 'upload rejected')

    // The final result arrives only after finish, but a failed chunk emits an
    // early ok:false frame — subscribe before streaming so neither is missed.
    // Keep the cancel handle: if a chunk emit fails mid-stream we must tear this
    // subscription down, else its listener leaks and its timer later rejects a
    // promise no one holds (unhandled rejection).
    const { promise: finished, cancel } = this.rpc.nextCancelable<FilePutResult>(
      'file_put_result',
      requestId,
      { timeoutMs },
    )

    let failed = false
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES)
      if (!socket.emit('file_put_chunk', { clientId, requestId, offset, data: bytesToBase64(chunk) })) {
        // Settle `finished` via cancel and let the single await below surface the
        // rejection — throwing separately would leave `finished` unawaited.
        cancel(new FileOpError('write', path, 'connection lost mid-upload'))
        failed = true
        break
      }
    }
    if (!failed) socket.emit('file_put_finish', { clientId, requestId })

    const result = await finished
    if (!result.ok) throw new FileOpError('write', path, result.error ?? 'upload failed')
  }

  async delete(clientId: string, path: string, recursive = false): Promise<void> {
    const result = await this.rpc.call<FileDeleteResult>(
      'file_delete_request',
      'file_delete_result',
      { clientId, requestId: newRequestId(), path, recursive, force: false },
    )
    if (!result.ok) throw new FileOpError('delete', path, result.error ?? 'unknown error')
  }

  /** Create a directory (and any missing parents) on the agent. */
  async mkdir(clientId: string, path: string): Promise<void> {
    const result = await this.rpc.call<FileMkdirResult>(
      'file_mkdir_request',
      'file_mkdir_result',
      { clientId, requestId: newRequestId(), path, force: false },
    )
    if (!result.ok) throw new FileOpError('mkdir', path, result.error ?? 'unknown error')
  }

  /** Rename or move a file/directory on the agent. */
  async rename(clientId: string, path: string, newPath: string): Promise<void> {
    const result = await this.rpc.call<FileRenameResult>(
      'file_rename_request',
      'file_rename_result',
      { clientId, requestId: newRequestId(), path, newPath, force: false },
    )
    if (!result.ok) throw new FileOpError('rename', path, result.error ?? 'unknown error')
  }

  async chmod(clientId: string, path: string, mode: string): Promise<void> {
    const result = await this.rpc.call<FileChmodResult>(
      'file_chmod_request',
      'file_chmod_result',
      { clientId, requestId: newRequestId(), path, mode },
    )
    if (!result.ok) throw new FileOpError('chmod', path, result.error ?? 'unknown error')
  }
}

export const fileService = new FileService()
