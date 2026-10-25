import { describe, expect, it } from 'vitest'
import { railSlot, shuffled } from '../../src/lib/feeds'

describe('Home suggestion rails', () => {
  it('places the first rail after the third post, then one every five posts', () => {
    const slots = Array.from({ length: 25 }, (_, i) => railSlot(i))
    expect(slots.flatMap((s, i) => (s >= 0 ? [[i, s]] : []))).toEqual([[2, 0], [7, 1], [12, 2], [17, 3], [22, 4]])
  })
  it('shuffles without losing, duplicating or mutating anything', () => {
    const kinds = ['people', 'reels', 'memories', 'plans', 'artists']
    const out = shuffled(kinds, () => 0)
    expect([...out].sort()).toEqual([...kinds].sort())
    expect(out).not.toEqual(kinds)
    expect(kinds).toEqual(['people', 'reels', 'memories', 'plans', 'artists'])
  })
})
