import { baseName } from './paths'

/**
 * Extension → MIME mapping for the content-aware viewers. The remote agent's
 * directory listing carries no MIME type (see docs/PROTOCOL.md), so the IDE
 * infers it from the filename — the same approach `cm/setup.ts` uses to pick a
 * language pack. Viewers register against these MIME types via `viewers.ts`.
 */

/** The lowercase extension of a path, without the dot ('' if none). */
export function extName(path: string): string {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

// Kept intentionally small and developer-focused — the file types you actually
// hit in a repo. Unknown extensions resolve to a generic type and fall through
// to the text editor.
const EXT_MIME: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  // video
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  // documents / archives
  pdf: 'application/pdf',
  zip: 'application/zip',
  // markdown
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdown: 'text/markdown',
  mkd: 'text/markdown',
}

const DEFAULT_MIME = 'application/octet-stream'

/** Best-guess MIME type for a path, by extension. */
export function mimeForPath(path: string): string {
  return EXT_MIME[extName(path)] ?? DEFAULT_MIME
}

/** The top-level type of a MIME string ('image/png' → 'image'). */
export function mimeCategory(mime: string): string {
  const slash = mime.indexOf('/')
  return slash > 0 ? mime.slice(0, slash) : mime
}

export const isImage = (mime: string): boolean => mimeCategory(mime) === 'image'
export const isAudio = (mime: string): boolean => mimeCategory(mime) === 'audio'
export const isVideo = (mime: string): boolean => mimeCategory(mime) === 'video'
export const isPdf = (mime: string): boolean => mime === 'application/pdf'
export const isZip = (mime: string): boolean => mime === 'application/zip'
export const isMarkdown = (mime: string): boolean => mime === 'text/markdown'
