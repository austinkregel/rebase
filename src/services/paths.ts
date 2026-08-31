/**
 * OS-aware path helpers for the remote file tree. The agent reports its OS via
 * the `platform` field of the control plane's client_list (gopsutil's
 * `host.Info().Platform` — e.g. "ubuntu", "darwin", or a string containing
 * "Windows"). We can't run Node's `path` here because the paths describe the
 * *remote* host, which may differ from the machine running the IDE.
 */

/** True when an agent's reported platform looks like Windows. */
export function isWindowsPlatform(platform?: string): boolean {
  return !!platform && /windows/i.test(platform)
}

/**
 * True when a path string is Windows-style. Keyed on a leading drive letter
 * (`C:`) only — a bare backslash is a legal filename character on POSIX, so
 * `path.includes('\\')` would misclassify e.g. `/tmp/a\b` as Windows.
 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path)
}

/** Default filesystem root to browse for an agent's reported platform. */
export function defaultRootForPlatform(platform?: string): string {
  return isWindowsPlatform(platform) ? 'C:\\' : '/'
}

/**
 * Join a child name onto a parent directory using the separator that matches
 * the parent's path style, so `C:\` + `Users` → `C:\Users` and `/` + `etc` →
 * `/etc`.
 */
export function joinPath(parent: string, name: string): string {
  if (isWindowsPath(parent)) {
    return parent.endsWith('\\') ? `${parent}${name}` : `${parent}\\${name}`
  }
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** Strip a trailing separator from a path (but keep a bare root like "/" or "C:\"). */
export function normalizeRoot(path: string): string {
  const p = path.trim()
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\')) && !/^[A-Za-z]:\\$/.test(p)) {
    return p.replace(/[/\\]+$/, '')
  }
  return p
}

/** The final path segment (file or folder name). */
export function baseName(path: string): string {
  const sep = isWindowsPath(path) ? '\\' : '/'
  const trimmed = path.replace(/[/\\]+$/, '')
  const idx = trimmed.lastIndexOf(sep)
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** The containing directory of a path (OS-aware). Roots map to themselves. */
export function parentDir(path: string): string {
  if (isWindowsPath(path)) {
    const trimmed = path.replace(/\\+$/, '')
    const idx = trimmed.lastIndexOf('\\')
    if (idx < 0) return path
    // Keep the trailing slash on a drive root: "C:\Users" → "C:\".
    return idx <= 2 ? trimmed.slice(0, idx + 1) : trimmed.slice(0, idx)
  }
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}
