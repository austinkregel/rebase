import { socket } from '@/transport/socket'
import { Rpc, RpcTimeoutError, newRequestId } from '@/transport/rpc'
import { base64ToBytes, bytesToBase64, decodeText, encodeText } from '@/transport/encoding'
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
 *  a Blob URL, so cap it. Text reads are unbounded (source files are small). */
const MAX_BINARY_BYTES = 50 * 1024 * 1024

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
    return this.rpc.call<ExecResult>(
      'exec_request',
      'exec_result',
      {
        clientId,
        requestId: newRequestId(),
        command,
        cwd: cwd ?? '',
        ...(opts?.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
      },
      { timeoutMs: opts?.timeoutMs ?? LIST_TIMEOUT_MS },
    )
  }

  /** Stat by listing the parent — the protocol has no dedicated stat. */
  async stat(clientId: string, path: string): Promise<DirListEntry | null> {
    const slash = path.lastIndexOf('/')
    const parent = slash > 0 ? path.slice(0, slash) : '/'
    const name = path.slice(slash + 1)
    const entries = await this.list(clientId, parent)
    return entries.find((e) => e.name === name) ?? null
  }

  /**
   * Read file content as text. Implements the proposed `file_get` extension
   * (docs/PROTOCOL.md "PROTOCOL GAP") — fails with a clear error until the
   * server and agent support it.
   */
  async read(clientId: string, path: string): Promise<string> {
    return decodeText(await this.fetchBytes(clientId, path))
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
    return this.fetchBytes(clientId, path, maxBytes, timeoutMs)
  }

  /** Stream the chunked `file_get` download and reassemble the raw bytes. */
  private async fetchBytes(
    clientId: string,
    path: string,
    maxBytes?: number,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const requestId = newRequestId()
    const chunks: FileGetChunk[] = []

    const stopChunks = this.rpc.expect('file_get_chunk', requestId, (data) => {
      chunks.push(data as unknown as FileGetChunk)
    })
    // The control plane emits `file_get_dispatched` the instant it forwards the
    // request to the agent. Tracking it lets a timeout pinpoint the stale hop:
    // no dispatch → the control plane doesn't route file_get; dispatched but no
    // result → the agent on that server doesn't handle it.
    let dispatched = false
    const stopDispatched = this.rpc.expect('file_get_dispatched', requestId, () => {
      dispatched = true
    })
    try {
      const result = await this.rpc.call<FileGetResult>(
        'file_get_request',
        'file_get_result',
        { clientId, requestId, path, ...(maxBytes != null ? { maxSize: maxBytes } : {}) },
        { timeoutMs },
      )
      if (!result.ok) throw new FileOpError('read', path, result.error ?? 'unknown error')
      if (maxBytes != null && result.size != null && result.size > maxBytes) {
        throw new FileOpError(
          'read',
          path,
          `file is ${formatBytes(result.size)} — too large to open here (limit ${formatBytes(maxBytes)})`,
        )
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
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return bytes
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
   *  an optional unix mode string ("0755") applied on creation. */
  async writeBytes(
    clientId: string,
    path: string,
    bytes: Uint8Array,
    mode?: string,
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
    const finished = this.rpc.next<FilePutResult>('file_put_result', requestId)

    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES)
      if (!socket.emit('file_put_chunk', { clientId, requestId, offset, data: bytesToBase64(chunk) })) {
        throw new FileOpError('write', path, 'connection lost mid-upload')
      }
    }
    socket.emit('file_put_finish', { clientId, requestId })

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
