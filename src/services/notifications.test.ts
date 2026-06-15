import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetNotifications,
  activeToasts,
  clear,
  clearRead,
  dismiss,
  dismissToast,
  formatTimeAgo,
  markAllRead,
  markRead,
  notifications,
  notify,
  unreadCount,
} from './notifications'

afterEach(() => _resetNotifications())

describe('notify defaults', () => {
  it('defaults level to info and starts unread + as a toast', () => {
    const id = notify({ title: 'hi' })
    const n = notifications().find((x) => x.id === id)!
    expect(n.level).toBe('info')
    expect(n.read).toBe(false)
    expect(n.toast).toBe(true)
    expect(n.sticky).toBe(false)
    expect(n.timeoutMs).toBeGreaterThan(0)
  })

  it('errors are sticky with no auto-dismiss timeout', () => {
    notify.error('boom')
    const n = notifications()[0]
    expect(n.level).toBe('error')
    expect(n.sticky).toBe(true)
    expect(n.timeoutMs).toBe(0)
  })

  it('level shortcuts pass through options', () => {
    notify.warning('careful', { source: 'Git', sticky: true })
    const n = notifications()[0]
    expect(n.level).toBe('warning')
    expect(n.source).toBe('Git')
    expect(n.sticky).toBe(true)
  })
})

describe('history + read state', () => {
  it('keeps newest first and counts unread', () => {
    notify.info('a')
    notify.info('b')
    expect(notifications().map((n) => n.title)).toEqual(['b', 'a'])
    expect(unreadCount()).toBe(2)
    markRead(notifications()[0].id)
    expect(unreadCount()).toBe(1)
    markAllRead()
    expect(unreadCount()).toBe(0)
  })

  it('caps history at 200, dropping the oldest', () => {
    for (let i = 0; i < 205; i++) notify.info(`n${i}`)
    expect(notifications()).toHaveLength(200)
    expect(notifications()[0].title).toBe('n204')
    expect(notifications().at(-1)!.title).toBe('n5')
  })
})

describe('toast vs center lifecycle', () => {
  it('dismissToast removes from toasts but keeps history; dismiss removes both', () => {
    const id = notify.info('keep')
    expect(activeToasts().some((n) => n.id === id)).toBe(true)
    dismissToast(id)
    expect(activeToasts().some((n) => n.id === id)).toBe(false)
    expect(notifications().some((n) => n.id === id)).toBe(true)
    dismiss(id)
    expect(notifications().some((n) => n.id === id)).toBe(false)
  })

  it('activeToasts is oldest→newest so the newest renders nearest the tray', () => {
    notify.info('first')
    notify.info('second')
    expect(activeToasts().map((n) => n.title)).toEqual(['first', 'second'])
  })
})

describe('clearing', () => {
  it('clear empties everything; clearRead keeps unread', () => {
    notify.info('one')
    notify.info('two')
    markRead(notifications()[0].id) // marks 'two'
    clearRead()
    expect(notifications().map((n) => n.title)).toEqual(['one'])
    clear()
    expect(notifications()).toHaveLength(0)
  })
})

describe('formatTimeAgo', () => {
  const now = 1_000_000_000_000
  it('buckets by magnitude', () => {
    expect(formatTimeAgo(now, now)).toBe('now')
    expect(formatTimeAgo(now - 30_000, now)).toBe('now')
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe('5m')
    expect(formatTimeAgo(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatTimeAgo(now - 2 * 86_400_000, now)).toBe('2d')
  })
})
