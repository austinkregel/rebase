import { reactive } from 'vue'

/**
 * App notification service — the client-side notification queue powering the
 * toast overlay (components/NotificationToasts.vue) and the notification center
 * (the bell popover). A reactive singleton, like the contribution registries in
 * services/*.ts. Any code can raise a notification via `notify()`; the toast
 * overlay and center read the live state below.
 *
 * Toast vs center: a new notification both shows as a transient *toast* and is
 * kept in *history*. Dismissing a toast (`dismissToast`) only removes it from the
 * toast stack — it stays in the center until `dismiss`/`clear`.
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface NotificationAction {
  label: string
  run: () => void | Promise<void>
  /** Dismiss the notification after the action runs (default true). */
  dismiss?: boolean
}

export interface AppNotification {
  id: string
  level: NotificationLevel
  title: string
  body?: string
  /** Origin label, e.g. 'Editor', 'Connection'. */
  source?: string
  createdAt: number
  read: boolean
  /** Still present in the transient toast stack. */
  toast: boolean
  /** Toast never auto-dismisses (errors default to sticky). */
  sticky: boolean
  /** Toast lifetime in ms before auto-dismiss (ignored when sticky). */
  timeoutMs: number
  actions?: NotificationAction[]
}

export interface NotifyInput {
  level?: NotificationLevel
  title: string
  body?: string
  source?: string
  sticky?: boolean
  timeoutMs?: number
  actions?: NotificationAction[]
}

/** Options for the level shortcuts (`notify.error(title, opts)`). */
export type NotifyOptions = Omit<NotifyInput, 'title' | 'level'>

/** Newest first. Capped so a long-running session can't grow unbounded. */
const MAX_HISTORY = 200

/** Default toast lifetimes by level; errors are sticky (never auto-dismiss). */
const DEFAULT_TIMEOUT: Record<NotificationLevel, number> = {
  info: 5000,
  success: 5000,
  warning: 8000,
  error: 0,
}

const state = reactive({ list: [] as AppNotification[] })

let seq = 0
function nextId(): string {
  return `n${++seq}`
}

interface NotifyFn {
  (input: NotifyInput): string
  info(title: string, opts?: NotifyOptions): string
  success(title: string, opts?: NotifyOptions): string
  warning(title: string, opts?: NotifyOptions): string
  error(title: string, opts?: NotifyOptions): string
}

const notifyImpl = (input: NotifyInput): string => {
  const level = input.level ?? 'info'
  const n: AppNotification = {
    id: nextId(),
    level,
    title: input.title,
    body: input.body,
    source: input.source,
    createdAt: Date.now(),
    read: false,
    toast: true,
    sticky: input.sticky ?? level === 'error',
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT[level],
    actions: input.actions,
  }
  state.list.unshift(n)
  if (state.list.length > MAX_HISTORY) state.list.length = MAX_HISTORY
  return n.id
}

/** Raise a notification (toast + center). Level shortcuts hang off this fn. */
export const notify = notifyImpl as NotifyFn
notify.info = (title, opts) => notifyImpl({ ...opts, title, level: 'info' })
notify.success = (title, opts) => notifyImpl({ ...opts, title, level: 'success' })
notify.warning = (title, opts) => notifyImpl({ ...opts, title, level: 'warning' })
notify.error = (title, opts) => notifyImpl({ ...opts, title, level: 'error' })

/** Remove a notification from both the toast stack and the center. */
export function dismiss(id: string): void {
  const i = state.list.findIndex((n) => n.id === id)
  if (i !== -1) state.list.splice(i, 1)
}

/** Remove only from the toast stack; it stays in the center history. */
export function dismissToast(id: string): void {
  const n = state.list.find((x) => x.id === id)
  if (n) n.toast = false
}

export function markRead(id: string): void {
  const n = state.list.find((x) => x.id === id)
  if (n) n.read = true
}

export function markAllRead(): void {
  for (const n of state.list) n.read = true
}

/** Clear the whole center (and any lingering toasts). */
export function clear(): void {
  state.list.length = 0
}

/** Clear only read notifications (keep unread). */
export function clearRead(): void {
  state.list = state.list.filter((n) => !n.read)
}

/** Center history, newest first. */
export function notifications(): AppNotification[] {
  return state.list
}

/** Active toasts in display order (oldest → newest, so newest renders nearest the tray). */
export function activeToasts(): AppNotification[] {
  return state.list.filter((n) => n.toast).reverse()
}

export function unreadCount(): number {
  return state.list.reduce((n, x) => n + (x.read ? 0 : 1), 0)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact relative time: 'now' | '2m' | '1h' | '3d' | 'M/D'. */
export function formatTimeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < MINUTE) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Test/teardown helper. */
export function _resetNotifications(): void {
  state.list.length = 0
  seq = 0
}
