import { markRaw, reactive, type Component } from 'vue'
import { mimeForPath } from './mime'

/**
 * Viewer contribution registry — lets a plugin claim one or more MIME types and
 * render them with a custom component, instead of the default CodeMirror text
 * editor. The built-in image/pdf/media/zip/markdown viewers register through
 * this same API (src/plugins/viewers), so a third party can add a `.glb` or
 * `.parquet` viewer the same way. Mirrors the shape of `services/views.ts`.
 */

export interface ViewerContext {
  path: string
  clientId: string
  /** Resolved MIME type for the file (see services/mime.ts). */
  mime: string
}

export interface ViewerContribution {
  id: string
  /**
   * MIME types this viewer handles. Exact ('application/pdf'), wildcard
   * ('image/*'), or '*' as a catch-all. On overlap, an exact match beats a
   * 'type/*' wildcard beats '*'; ties break by descending `priority`, then id.
   */
  mimeTypes: string[]
  priority?: number
  /**
   * false → the file is *not* text-decoded; the viewer fetches its own bytes
   * (via fileService.readBytes) and is treated as read-only. true-less viewers
   * like markdown read the text buffer the editor already loaded.
   */
  binary: boolean
  /** Offer a "View Source" toggle that falls back to the text editor (md, svg). */
  allowRawToggle?: boolean
  /** Receives props: { path, clientId, mime, content? } — see ViewerContext. */
  component: Component
}

const registry = reactive(new Map<string, ViewerContribution>())

export function registerViewer(v: ViewerContribution): () => void {
  const raw = markRaw(v)
  registry.set(raw.id, raw)
  return () => {
    if (registry.get(raw.id) === raw) registry.delete(raw.id)
  }
}

/** Specificity of a viewer's best-matching pattern for `mime` (higher = better). */
function matchScore(v: ViewerContribution, mime: string): number {
  const category = mime.slice(0, mime.indexOf('/'))
  let best = -1
  for (const pattern of v.mimeTypes) {
    if (pattern === mime) best = Math.max(best, 3)
    else if (pattern.endsWith('/*') && pattern.slice(0, -2) === category) best = Math.max(best, 2)
    else if (pattern === '*') best = Math.max(best, 1)
  }
  return best
}

/** The best viewer registered for a MIME type, or undefined for none. */
export function viewerForMime(mime: string): ViewerContribution | undefined {
  let winner: ViewerContribution | undefined
  let winnerScore = 0
  for (const v of registry.values()) {
    const score = matchScore(v, mime)
    if (score <= 0) continue
    if (
      score > winnerScore ||
      (score === winnerScore && winner && betterTie(v, winner))
    ) {
      winner = v
      winnerScore = score
    }
  }
  return winner
}

function betterTie(a: ViewerContribution, b: ViewerContribution): boolean {
  const pa = a.priority ?? 0
  const pb = b.priority ?? 0
  return pa !== pb ? pa > pb : a.id < b.id
}

/** Convenience: resolve a path's MIME type, then its viewer. */
export function viewerFor(path: string): ViewerContribution | undefined {
  return viewerForMime(mimeForPath(path))
}
