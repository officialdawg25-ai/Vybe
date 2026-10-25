import { describe, expect, it } from 'vitest'
import { percentile, routeBucket } from '../../src/lib/metrics'

describe('field performance numbers', () => {
  it('screens are reported only as coarse buckets, never as the path itself', () => {
    expect(routeBucket('/app')).toBe('home')
    expect(routeBucket('/app/discover/category/music')).toBe('discover')
    expect(routeBucket('/app/reels')).toBe('reels')
    expect(routeBucket('/app/live/5f1c')).toBe('live')
    expect(routeBucket('/app/u/alice')).toBe('profile')
    expect(routeBucket('/app/messages/123')).toBe('other')
    expect(routeBucket('/admin')).toBe('other')
  })
  it('percentiles use the nearest-rank method', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5)
    expect(percentile([], 75)).toBeNull()
  })
})
