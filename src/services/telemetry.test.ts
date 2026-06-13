import { describe, it, expect } from 'vitest'
import { DISK_WARN_PCT, parseTelemetry, pctColor } from './telemetry'
import type { StatsData } from '@/transport/types'

describe('parseTelemetry', () => {
  it('returns null for missing stats', () => {
    expect(parseTelemetry(undefined)).toBeNull()
    expect(parseTelemetry(null)).toBeNull()
  })

  it('derives cpu/mem/disk from a full sample', () => {
    const stats: StatsData = {
      cpu: 42,
      mem: { used: 8, total: 16 },
      disk: [
        { mount: '/', capacity: 55 },
        { mount: '/data', capacity: 80 },
      ],
    }
    const t = parseTelemetry(stats)!
    expect(t.cpuPct).toBe(42)
    expect(t.memPct).toBe(50)
    expect(t.worstDiskPct).toBe(80)
    expect(t.worstDiskMount).toBe('/data')
    expect(t.diskWarning).toBe(false)
  })

  it('computes memory from free when used is absent', () => {
    const t = parseTelemetry({ mem: { free: 4, total: 16 } })!
    expect(t.memPct).toBe(75)
  })

  it('flags a near-full disk', () => {
    const t = parseTelemetry({ disk: [{ mount: '/', capacity: DISK_WARN_PCT }] })!
    expect(t.diskWarning).toBe(true)
    expect(t.worstDiskMount).toBe('/')
  })

  it('hides battery and thermal when absent (servers)', () => {
    const t = parseTelemetry({ cpu: 10 })!
    expect(t.battery).toBeNull()
    expect(t.maxTempC).toBeNull()
    expect(t.tempWarning).toBe(false)
  })

  it('surfaces battery percent + charging state', () => {
    expect(parseTelemetry({ battery: { status: 'Charging', percent: 80 } })!.battery).toEqual({
      percent: 80,
      charging: true,
    })
    expect(parseTelemetry({ battery: { status: 'Discharging', percent: 30 } })!.battery).toEqual({
      percent: 30,
      charging: false,
    })
  })

  it('takes the hottest sensor and warns near the limit', () => {
    const t = parseTelemetry({
      thermal: [
        { component: 'cpu', temperature: 55, high: 90 },
        { component: 'gpu', temperature: 88, high: 90 },
      ],
    })!
    expect(t.maxTempC).toBe(88)
    expect(t.tempWarning).toBe(true) // 88 >= 90 - 5
  })

  it('does not warn on a cool sensor', () => {
    const t = parseTelemetry({ thermal: [{ temperature: 40, critical: 100 }] })!
    expect(t.maxTempC).toBe(40)
    expect(t.tempWarning).toBe(false)
  })

  it('clamps out-of-range cpu', () => {
    expect(parseTelemetry({ cpu: 130 })!.cpuPct).toBe(100)
    expect(parseTelemetry({ cpu: -5 })!.cpuPct).toBe(0)
  })
})

describe('pctColor', () => {
  it('ramps green → yellow → red', () => {
    expect(pctColor(10)).toContain('green')
    expect(pctColor(75)).toContain('yellow')
    expect(pctColor(95)).toContain('red')
    expect(pctColor(null)).toContain('muted')
  })
})
