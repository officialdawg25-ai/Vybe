import { describe, expect, it } from 'vitest'
import { songTimeFor } from '../../src/lib/syncAudio'

describe('songTimeFor: where the song should be for a given video time', () => {
  it('starts at the moment the author chose', () => {
    expect(songTimeFor(0, { start: 12, clip: 30 })).toBe(12)
    expect(songTimeFor(3.5, { start: 12, clip: 30 })).toBeCloseTo(15.5)
  })
  it('counts from the trim start and divides by the creator speed (the song was laid in real time)', () => {
    expect(songTimeFor(4, { start: 10, clip: 0, trimStart: 2, speed: 2 })).toBeCloseTo(11)
    expect(songTimeFor(1, { start: 10, clip: 0, trimStart: 2 })).toBe(10)      // before the trim start: the beginning
  })
  it('wraps inside the clip, and never past the end of the song file', () => {
    expect(songTimeFor(31, { start: 5, clip: 30 })).toBeCloseTo(6)
    expect(songTimeFor(12, { start: 35, clip: 30, duration: 40 })).toBeCloseTo(37)   // only 5 s left after 35 s
  })
})
