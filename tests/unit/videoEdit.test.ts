import { describe, expect, it } from 'vitest'
import { MIN_CLIP, clampTrim, clock, editColumns } from '../../src/lib/videoEdit'

describe('video editor settings', () => {
  it('stores nothing for an untouched video', () => {
    expect(editColumns(null, 12)).toEqual({})
    expect(editColumns({ start: 0, end: 12, muted: false }, 12)).toEqual({})
  })
  it('stores a trim in milliseconds and the sound-off choice', () => {
    expect(editColumns({ start: 1.25, end: 6, muted: false }, 12)).toEqual({ trim_start_ms: 1250, trim_end_ms: 6000 })
    expect(editColumns({ start: 0, end: 12, muted: true }, 12)).toEqual({ muted: true })
    expect(editColumns({ start: 2, end: 5, muted: true }, 12)).toEqual({ trim_start_ms: 2000, trim_end_ms: 5000, muted: true })
  })
  it('never stores a trim shorter than half a second or past the end', () => {
    expect(editColumns({ start: 3, end: 3.2, muted: false }, 12)).toEqual({})
    expect(editColumns({ start: 4, end: 99, muted: false }, 12)).toEqual({ trim_start_ms: 4000, trim_end_ms: 12000 })
  })
  it('a trim whose length is unknown is not stored (only the sound choice)', () => {
    expect(editColumns({ start: 1, end: 3, muted: true }, null)).toEqual({ muted: true })
  })
  it('keeps the handles in order, inside the video and at least half a second apart', () => {
    expect(clampTrim(5, 5.1, 10, 'start')).toEqual({ start: 5 - (MIN_CLIP - 0.1), end: 5.1 })
    const e = clampTrim(2, 2.1, 10, 'end'); expect(e.start).toBe(2); expect(e.end).toBeCloseTo(2 + MIN_CLIP)
    expect(clampTrim(-3, 99, 10, 'start')).toEqual({ start: 0, end: 10 })
  })
  it('formats times for the editor', () => { expect(clock(0)).toBe('0:00.0'); expect(clock(65.25)).toBe('1:05.3') })
})
