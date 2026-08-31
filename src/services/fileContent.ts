import { fileService } from '@/services/fileService'
import { decodeText, encodeText } from '@/transport/encoding'
import { mimeForPath } from '@/services/mime'
import { viewerFor } from '@/services/viewers'
import { baseName, parentDir } from '@/services/paths'
import type { DirListEntry } from '@/transport/types'

/**
 * Centralized, hardened policy for opening file content. `fileService` is the
 * wire adapter (bytes on/off the socket); THIS module decides — from metadata
 * plus a content sniff, never the filename alone — how a file may be opened:
 * editable text, a content viewer, read-only hex, a bounded preview, or not at
 * all. It is the single guard against the historical hazard of decoding a binary
 * file into an editable UTF-8 buffer and corrupting it on save.
 */

/** One place for every read/preview ceiling (replaces scattered constants). */
export const FILE_LIMITS = {
  /** Bytes scanned by the content sniffer for text-vs-binary. */
  probeBytes: 64 * 1024,
  /** A clean-UTF-8 file at/under this is editable; larger text is read-only.
   *  Kept under the agent's whole-file file_get limit (compute-agent
   *  fileGetMaxBytes = 32 MiB) so an in-cap file always reads. */
  editableMaxBytes: 25 * 1024 * 1024,
  /** Read-only text preview page size (paged fully once ranged reads land). */
  textPreviewBytes: 2 * 1024 * 1024,
  /** Blob-building binary viewers (image/media) ceiling. Matches the agent's
   *  32 MiB whole-file file_get limit — beyond it the agent rejects the read, so
   *  classify as too-large and show a clean banner instead of a failed round-trip. */
  binaryViewerMaxBytes: 32 * 1024 * 1024,
  /** Hex viewer page size. */
  hexPageBytes: 16 * 1024,
  /** Per-entry preview inside the zip viewer. */
  zipPreviewBytes: 2 * 1024 * 1024,
  /** Absolute refuse-to-buffer ceiling. */
  hardCeilingBytes: 512 * 1024 * 1024,
} as const

export type FileContentKind =
  | 'directory'
  | 'special' // socket / device / FIFO — unsafe to read
  | 'too-large' // over the editable/hard ceiling — read-only, preview needs ranged reads
  | 'text' // clean UTF-8, editable
  | 'binary-viewer' // a registered binary viewer renders it (image/pdf/media/zip)
  | 'binary-hex' // binary or lossy — read-only hex
  | 'text-viewer' // a text-backed viewer (markdown/svg) over an editable buffer

export type FileSpecial = 'socket' | 'device' | 'fifo'

export interface FileContentPlan {
  clientId: string
  path: string
  kind: FileContentKind
  mime: string
  /** Total size in bytes, or -1 when unknown (e.g. /proc). */
  size: number
  mode?: string
  isSymlink?: boolean
  special?: FileSpecial
  viewerId?: string
  editable: boolean
  truncated: boolean
  /** Human-readable reason a file is read-only / not shown (banner text). */
  reason?: string
}

export interface OpenResolution {
  plan: FileContentPlan
  /** Decoded text for `text` / `text-viewer`; undefined otherwise. */
  content?: string
}

export interface Sniff {
  kind: 'text' | 'binary' | 'empty'
  /** Bytes are valid UTF-8 that re-encodes identically (losslessly editable). */
  cleanUtf8: boolean
  encoding?: 'utf-8' | 'utf-16' | 'unknown'
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Trim a trailing partial UTF-8 sequence so a probe cut mid-codepoint isn't
 *  misjudged as invalid (matters once probes are truncated ranged reads). */
function trimToUtf8Boundary(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1
  let cont = 0
  while (i >= 0 && (bytes[i] & 0xc0) === 0x80 && cont < 3) {
    cont++
    i--
  }
  if (i < 0) return bytes
  const lead = bytes[i]
  let expected = 1
  if ((lead & 0x80) === 0) expected = 1
  else if ((lead & 0xe0) === 0xc0) expected = 2
  else if ((lead & 0xf0) === 0xe0) expected = 3
  else if ((lead & 0xf8) === 0xf0) expected = 4
  else return bytes // invalid lead byte — leave for the losslessness check to catch
  return cont + 1 < expected ? bytes.subarray(0, i) : bytes
}

/**
 * Classify bytes as text or binary, and whether text is losslessly UTF-8
 * (the editability gate). Never trusts the extension.
 */
export function sniff(bytes: Uint8Array): Sniff {
  if (bytes.length === 0) return { kind: 'empty', cleanUtf8: true, encoding: 'utf-8' }
  // UTF-16 BOM → text, but not clean UTF-8, so read-only (transcoding on save
  // would rewrite the whole file's encoding — dangerous).
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return { kind: 'text', cleanUtf8: false, encoding: 'utf-16' }
  }
  const scan = Math.min(bytes.length, 4096)
  let control = 0
  for (let i = 0; i < scan; i++) {
    const b = bytes[i]
    if (b === 0) return { kind: 'binary', cleanUtf8: false } // NUL ⇒ binary
    // Control bytes excluding the text whitespace \t(9) \n(10) \r(13).
    if (b < 0x09 || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f)) control++
  }
  if (control / scan > 0.3) return { kind: 'binary', cleanUtf8: false }
  const trimmed = trimToUtf8Boundary(bytes)
  const clean = bytesEqual(encodeText(decodeText(trimmed)), trimmed)
  return { kind: 'text', cleanUtf8: clean, encoding: clean ? 'utf-8' : 'unknown' }
}

function specialFromMode(mode?: string): FileSpecial | undefined {
  switch (mode?.[0]) {
    case 's':
      return 'socket'
    case 'c':
    case 'b':
      return 'device'
    case 'p':
      return 'fifo'
    default:
      return undefined
  }
}

function plan(base: FileContentPlan, over: Partial<FileContentPlan>): FileContentPlan {
  return { ...base, ...over }
}

/**
 * Decide how to open `path`, reading only what's needed to classify. Pass the
 * tree's known `DirListEntry` to skip a stat round-trip. In this (pre-ranged-read)
 * phase, files larger than the editable ceiling can't be windowed, so they are
 * classified read-only `too-large`; sub-ceiling files are read once, sniffed, and
 * decoded only when they're clean text.
 */
export async function resolveOpen(
  clientId: string,
  path: string,
  knownEntry?: DirListEntry,
): Promise<OpenResolution> {
  const entry = knownEntry ?? (await fileService.stat(clientId, path)) ?? undefined
  const mime = mimeForPath(path)
  const size = entry?.size ?? -1
  const base: FileContentPlan = {
    clientId,
    path,
    kind: 'text',
    mime,
    size,
    mode: entry?.mode,
    isSymlink: entry?.isSymlink,
    editable: false,
    truncated: false,
  }

  if (entry?.type === 'dir') {
    return { plan: plan(base, { kind: 'directory', reason: 'This is a directory.' }) }
  }

  const special = specialFromMode(entry?.mode)
  if (special) {
    return {
      plan: plan(base, {
        kind: 'special',
        special,
        reason: `This is a ${special}; its contents can't be safely read here.`,
      }),
    }
  }

  const viewer = viewerFor(path)
  if (viewer?.binary) {
    if (size >= 0 && size > FILE_LIMITS.binaryViewerMaxBytes) {
      return { plan: plan(base, { kind: 'too-large', viewerId: viewer.id, reason: 'File too large to render here.' }) }
    }
    return { plan: plan(base, { kind: 'binary-viewer', viewerId: viewer.id }) }
  }

  // Anything past the hard ceiling, or past the editable ceiling (which we can't
  // window without ranged reads), is read-only and not classified further here.
  if (size >= 0 && size > FILE_LIMITS.hardCeilingBytes) {
    return { plan: plan(base, { kind: 'too-large', viewerId: viewer?.id, reason: 'File too large to open.' }) }
  }
  if (size >= 0 && size > FILE_LIMITS.editableMaxBytes) {
    return {
      plan: plan(base, {
        kind: 'too-large',
        viewerId: viewer?.id,
        truncated: true,
        reason: 'File too large to open — paged preview needs a ranged-read-capable agent.',
      }),
    }
  }

  // Sub-ceiling (or unknown size): read once and classify from the actual bytes.
  const bytes = await fileService.readBytes(clientId, path, FILE_LIMITS.editableMaxBytes)
  const actualSize = size >= 0 ? size : bytes.length
  const s = sniff(bytes)

  if (viewer && !viewer.binary) {
    // Text-backed viewer (markdown/svg): render it, editability gated on clean text.
    return {
      plan: plan(base, {
        kind: 'text-viewer',
        viewerId: viewer.id,
        size: actualSize,
        editable: s.cleanUtf8 && actualSize <= FILE_LIMITS.editableMaxBytes,
      }),
      content: decodeText(bytes),
    }
  }

  if (s.kind !== 'binary' && s.cleanUtf8) {
    return {
      plan: plan(base, { kind: 'text', size: actualSize, editable: true }),
      content: decodeText(bytes),
    }
  }

  // Binary or lossy → read-only hex (the HexViewer fetches its own bytes).
  return {
    plan: plan(base, {
      kind: 'binary-hex',
      size: actualSize,
      reason: s.encoding === 'utf-16' ? 'UTF-16 text — shown read-only.' : 'Binary file — shown as hex.',
    }),
  }
}

/**
 * Safe text read for the agent tools: clean text is returned verbatim; binary,
 * oversized, or special files return `binary:true` and no text, so callers emit
 * a "[binary file]" stub instead of feeding mojibake into a prompt or an edit.
 */
export async function readTextForAgent(
  clientId: string,
  path: string,
): Promise<{ text: string; binary: boolean; size: number; mime: string }> {
  const { plan: p, content } = await resolveOpen(clientId, path)
  const isText = p.kind === 'text' || p.kind === 'text-viewer'
  return { text: isText ? content ?? '' : '', binary: !isText, size: p.size, mime: p.mime }
}

// Re-exported so callers don't reach into paths for the common entry lookup.
export { baseName, parentDir }
