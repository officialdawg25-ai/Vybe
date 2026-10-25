import { describe, expect, it } from 'vitest'
import { RAILS_PER_VISIT, pickRails, railSlot, shuffled } from '../../src/lib/feeds'

const KINDS = ['people', 'reels', 'memories', 'plans', 'artists', 'communities', 'live']

describe('Home suggestion rails', () => {
  it('keeps rails well apart: after the 4th post, then every 8 posts', () => {
    const slots = Array.from({ length: 40 }, (_, i) => railSlot(i))
    expect(slots.flatMap((s, i) => (s >= 0 ? [[i, s]] : []))).toEqual([[3, 0], [11, 1], [19, 2], [27, 3], [35, 4]])
  })
  it('orders every kind not hidden, each once, so a slot can fall through to the next kind with content', () => {
    expect(RAILS_PER_VISIT).toBeLessThan(KINDS.length)
    for (let n = 0; n < 50; n++) {
      const picked = pickRails(KINDS, new Set(['reels', 'live']))
      expect(picked).toHaveLength(KINDS.length - 2)
      expect(new Set(picked).size).toBe(picked.length)
      expect(picked).not.toContain('reels')
      expect(picked).not.toContain('live')
    }
    expect(pickRails(KINDS, new Set(KINDS))).toEqual([])
  })
  it('shuffles without losing, duplicating or mutating anything', () => {
    const kinds = [...KINDS]
    const out = shuffled(kinds, () => 0)
    expect([...out].sort()).toEqual([...KINDS].sort())
    expect(out).not.toEqual(KINDS)
    expect(kinds).toEqual(KINDS)
  })
})
