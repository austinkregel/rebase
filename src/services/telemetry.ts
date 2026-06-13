import type { StatsData } from '@/transport/types'

/**
 * Normalizes a raw `stats` blob into the handful of glanceable values the
 * servers panel renders. Everything is defensive: servers report no battery or
 * thermal data, and older agents omit newer fields — missing data yields `null`
 * (hide the indicator) rather than a misleading zero.
 */

export interface BatteryView {
  percent: number
  charging: boolean
}

export interface TelemetryView {
  /** CPU utilization 0–100, or null when unknown. */
  cpuPct: number | null
  /** Memory utilization 0–100, or null. */
  memPct: number | null
  /** Worst (highest) disk utilization 0–100 across mounts, or null. */
  worstDiskPct: number | null
  /** Mount point of the worst disk, for a tooltip. */
  worstDiskMount: string | null
  /** True when any disk is at/above the near-full threshold. */
  diskWarning: boolean
  /** Hottest sensor reading in °C, or null. */
  maxTempC: number | null
  /** True when the hottest sensor is at/near its high/critical threshold. */
  tempWarning: boolean
  battery: BatteryView | null
}

/** Disk is flagged when used capacity reaches this percent. */
export const DISK_WARN_PCT = 90

function clampPct(n: number | undefined): number | null {
  if (typeof n !== 'number' || Number.isNaN(n)) return null
  return Math.max(0, Math.min(100, n))
}

function memPercent(stats: StatsData): number | null {
  const mem = stats.mem
  if (!mem || typeof mem.total !== 'number' || mem.total <= 0) return null
  const used = typeof mem.used === 'number' ? mem.used : (mem.total - (mem.free ?? 0))
  return clampPct((used / mem.total) * 100)
}

function worstDisk(stats: StatsData): { pct: number; mount: string } | null {
  const disks = stats.disk
  if (!Array.isArray(disks) || disks.length === 0) return null
  let worst: { pct: number; mount: string } | null = null
  for (const d of disks) {
    const pct = clampPct(d.capacity)
    if (pct === null) continue
    if (!worst || pct > worst.pct) worst = { pct, mount: d.mount ?? '' }
  }
  return worst
}

function hottest(stats: StatsData): { tempC: number; warning: boolean } | null {
  const sensors = stats.thermal
  if (!Array.isArray(sensors) || sensors.length === 0) return null
  let best: { tempC: number; warning: boolean } | null = null
  for (const s of sensors) {
    if (typeof s.temperature !== 'number' || Number.isNaN(s.temperature)) continue
    // Warn when within 5°C of high, or at/above critical.
    const limit = typeof s.critical === 'number' && s.critical > 0
      ? s.critical
      : typeof s.high === 'number' && s.high > 0
        ? s.high
        : null
    const warning = limit !== null && s.temperature >= limit - 5
    if (!best || s.temperature > best.tempC) best = { tempC: s.temperature, warning }
  }
  return best
}

function batteryView(stats: StatsData): BatteryView | null {
  const b = stats.battery
  if (!b) return null
  const percent = typeof b.percent === 'number'
    ? b.percent
    : b.devices?.find((d) => typeof d.percent === 'number')?.percent
  if (typeof percent !== 'number' || Number.isNaN(percent)) return null
  const status = (b.status ?? b.devices?.[0]?.status ?? '').toLowerCase()
  // "discharging" also contains "charg" — exclude it explicitly.
  const charging = status.includes('full') || (status.includes('charg') && !status.includes('discharg'))
  return { percent: Math.max(0, Math.min(100, percent)), charging }
}

export function parseTelemetry(stats: StatsData | undefined | null): TelemetryView | null {
  if (!stats) return null
  const disk = worstDisk(stats)
  const temp = hottest(stats)
  return {
    cpuPct: clampPct(stats.cpu),
    memPct: memPercent(stats),
    worstDiskPct: disk?.pct ?? null,
    worstDiskMount: disk?.mount ?? null,
    diskWarning: disk !== null && disk.pct >= DISK_WARN_PCT,
    maxTempC: temp?.tempC ?? null,
    tempWarning: temp?.warning ?? false,
    battery: batteryView(stats),
  }
}

/** Tailwind color token for a utilization percentage (green → yellow → red). */
export function pctColor(pct: number | null): string {
  if (pct === null) return 'var(--muted)'
  if (pct >= 90) return 'var(--red)'
  if (pct >= 70) return 'var(--yellow)'
  return 'var(--green)'
}
