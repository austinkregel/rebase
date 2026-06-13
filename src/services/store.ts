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
