import { describe, expect, it } from 'vitest'
import { formatEventTime, formatPrice, timeAgo, utcToZonedLocal, zonedLocalToUtc } from '../../src/lib/format'
import { validateMedia } from '../../src/lib/media'

describe('timeAgo', () => {
  const now = Date.parse('2026-10-19T12:00:00Z')
  it('formats ranges', () => {
    expect(timeAgo('2026-10-19T11:59:40Z', now)).toBe('now')
    expect(timeAgo('2026-10-19T11:55:00Z', now)).toBe('5m')
    expect(timeAgo('2026-10-19T09:00:00Z', now)).toBe('3h')
    expect(timeAgo('2026-10-17T12:00:00Z', now)).toBe('2d')
  })
})

describe('zonedLocalToUtc', () => {
  it('handles fixed and DST offsets', () => {
    expect(zonedLocalToUtc('2026-10-19T18:00', 'Africa/Johannesburg')).toBe('2026-10-19T16:00:00.000Z')
    expect(zonedLocalToUtc('2026-07-01T12:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z') // EDT
    expect(zonedLocalToUtc('2026-12-01T12:00', 'America/New_York')).toBe('2026-12-01T17:00:00.000Z') // EST
  })
  it('inverts with utcToZonedLocal across zones and DST', () => {
    for (const [local, tz] of [['2026-03-08T09:30', 'America/New_York'], ['2026-11-01T01:30', 'America/Los_Angeles'], ['2026-10-19T18:00', 'Asia/Kolkata'], ['2026-06-15T23:45', 'Australia/Sydney']]) {
      expect(utcToZonedLocal(zonedLocalToUtc(local, tz), tz)).toBe(local)
    }
  })
  it('round-trips through formatEventTime', () => {
    expect(formatEventTime('2026-10-19T16:00:00.000Z', 'Africa/Johannesburg', 'en-US')).toContain('6:00')
  })
})

describe('formatPrice', () => {
  it('shows Free for zero/null and localises currency', () => {
    expect(formatPrice(null, null)).toBe('Free')
    expect(formatPrice(0, 'ZAR')).toBe('Free')
    expect(formatPrice(15000, 'USD', 'en-US')).toBe('$150.00')
  })
})

describe('validateMedia', () => {
  it('accepts supported types within limits', () => {
    expect(validateMedia({ type: 'image/png', size: 1000 })).toEqual({ ok: true, type: 'image' })
    expect(validateMedia({ type: 'video/mp4', size: 1000 })).toEqual({ ok: true, type: 'video' })
  })
  it('rejects unsupported types and oversize files', () => {
    expect(validateMedia({ type: 'application/pdf', size: 10 }).ok).toBe(false)
    expect(validateMedia({ type: 'image/svg+xml', size: 10 }).ok).toBe(false)
    expect(validateMedia({ type: 'image/png', size: 11 * 1024 * 1024 }).ok).toBe(false)
    expect(validateMedia({ type: 'video/mp4', size: 51 * 1024 * 1024 }).ok).toBe(false)
  })
})
