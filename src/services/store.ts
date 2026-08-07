import { isTauri } from '@/transport/contract'

// Durable key-value persistence. Desktop writes a real JSON file via
// tauri-plugin-store; the browser falls back to localStorage. Pinia stores
// hydrate from this and save on change.

const FILE = 'rebase.json'
const PREFIX = 'rebase.'

// Lazy so the browser build never imports the Tauri plugin.
let tauriStore: Promise<import('@tauri-apps/plugin-store').Store> | null = null
function getTauriStore() {
  if (!tauriStore) {
    tauriStore = import('@tauri-apps/plugin-store').then((m) => m.load(FILE))
  }
  return tauriStore
}

export async function loadValue<T>(key: string, fallback: T): Promise<T> {
  if (isTauri()) {
    try {
      const store = await getTauriStore()
      const value = await store.get<T>(key)
      return value ?? fallback
    } catch {
      return fallback
    }
  }
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** Forget a key entirely (used to retire keys we no longer read). */
export async function removeValue(key: string): Promise<void> {
  if (isTauri()) {
    try {
      const store = await getTauriStore()
      await store.delete(key)
      await store.save()
    } catch {
      /* ignore persistence failure */
    }
    return
  }
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* ignore */
  }
}

/**
 * Load a key that used to be written to raw `localStorage`, adopting the old
 * value the first time and persisting it forward. On desktop those writes went
 * to the *webview's* localStorage rather than `rebase.json`, so without this
 * the move would silently reset everyone's window layout.
 *
 * `legacyKey` is the full old key (already prefixed). Delete this once installs
 * have rolled over — nothing but the migration depends on it.
 */
export async function loadValueMigrating<T>(key: string, legacyKey: string, fallback: T): Promise<T> {
  const sentinel = Symbol('missing')
  const current = await loadValue<T | typeof sentinel>(key, sentinel)
  if (current !== sentinel) return current as T
  try {
    const raw = localStorage.getItem(legacyKey)
    if (raw) {
      const value = JSON.parse(raw) as T
      await saveValue(key, value)
      localStorage.removeItem(legacyKey)
      return value
    }
  } catch {
    /* fall through to the default */
  }
  return fallback
}

export async function saveValue<T>(key: string, value: T): Promise<void> {
  if (isTauri()) {
    try {
      const store = await getTauriStore()
      await store.set(key, value)
      await store.save()
    } catch {
      /* ignore persistence failure */
    }
    return
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* ignore quota errors */
  }
}
