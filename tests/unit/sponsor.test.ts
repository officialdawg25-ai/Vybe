import { describe, expect, it } from 'vitest'
import { adSlot, ctr, effectiveStatus, isSecureLink } from '../../src/lib/sponsor'

describe('sponsored posts (client rules)', () => {
  it('ads come after the 6th post, then every 8, and never collide with suggestion rails', async () => {
    const { railSlot } = await import('../../src/lib/feeds')
    const ads = Array.from({ length: 60 }, (_, i) => i).filter(i => adSlot(i) >= 0)
    expect(ads.slice(0, 4)).toEqual([5, 13, 21, 29])
    expect(ads.map(adSlot).slice(0, 4)).toEqual([0, 1, 2, 3])
    for (const i of ads) expect(railSlot(i)).toBe(-1)
  })
  it('a live boost past its end time counts as finished', () => {
    const now = Date.parse('2026-11-20T12:00:00Z')
    expect(effectiveStatus({ status: 'live', ends_at: '2026-11-20T11:00:00Z' }, now)).toBe('ended')
    expect(effectiveStatus({ status: 'live', ends_at: '2026-11-21T11:00:00Z' }, now)).toBe('live')
    expect(effectiveStatus({ status: 'paused', ends_at: '2026-11-01T00:00:00Z' }, now)).toBe('paused')
    expect(effectiveStatus({ status: 'in_review', ends_at: null }, now)).toBe('in_review')
  })
  it('click-through rate is a percentage with one decimal and never divides by zero', () => {
    expect(ctr({ impressions: 0, clicks: 0, reach: 0 })).toBe(0)
    expect(ctr({ impressions: 200, clicks: 7, reach: 90 })).toBe(3.5)
  })
  it('only secure links are accepted', () => {
    expect(isSecureLink('https://tickets.example.com/party')).toBe(true)
    expect(isSecureLink('http://tickets.example.com/party')).toBe(false)
    expect(isSecureLink('javascript:alert(1)')).toBe(false)
    expect(isSecureLink('https://a b.example.com')).toBe(false)
    expect(isSecureLink('https://x.y')).toBe(false)
  })
})
