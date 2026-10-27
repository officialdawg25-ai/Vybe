import { describe, expect, it } from 'vitest'
import { pickVideoPath, type PickContext } from '../../src/lib/videoQuality'
import { copyPlan, recorderType, withWebmDuration } from '../../src/lib/videoCopy'

const ctx = (o: Partial<PickContext> = {}): PickContext => ({ saver: false, lowEnd: false, stalledLow: false, canPlay: () => true, broken: () => false, ...o })
const vid = { path: 'u/v.mp4', type: 'video', display_path: 'u/v-480.webm' }

describe('pickVideoPath: only real files are offered', () => {
  it('a video without a copy always plays the original and offers no choice', () => {
    for (const q of ['auto', 'original', 'small'] as const) expect(pickVideoPath({ path: 'u/v.mp4', type: 'video' }, q, ctx({ saver: true }))).toEqual({ path: 'u/v.mp4', small: false, hasCopy: false })
  })
  it('photos are never treated as videos', () => {
    expect(pickVideoPath({ path: 'u/p.jpg', type: 'image', display_path: 'u/p.webp' }, 'small', ctx()).hasCopy).toBe(false)
  })
  it('Auto: the original normally; the copy on Data saver, a low-end device or after repeated stalls', () => {
    expect(pickVideoPath(vid, 'auto', ctx()).path).toBe('u/v.mp4')
    expect(pickVideoPath(vid, 'auto', ctx({ saver: true })).path).toBe('u/v-480.webm')
    expect(pickVideoPath(vid, 'auto', ctx({ lowEnd: true })).path).toBe('u/v-480.webm')
    expect(pickVideoPath(vid, 'auto', ctx({ stalledLow: true })).path).toBe('u/v-480.webm')
  })
  it('an explicit choice wins over the conditions', () => {
    expect(pickVideoPath(vid, 'original', ctx({ saver: true })).path).toBe('u/v.mp4')
    expect(pickVideoPath(vid, 'small', ctx()).path).toBe('u/v-480.webm')
  })
  it('a copy this browser cannot play, or that failed, falls back to the original', () => {
    expect(pickVideoPath(vid, 'small', ctx({ canPlay: () => false }))).toEqual({ path: 'u/v.mp4', small: false, hasCopy: false })
    expect(pickVideoPath(vid, 'small', ctx({ broken: p => p === 'u/v-480.webm' })).path).toBe('u/v.mp4')
  })
})

describe('copyPlan: when a smaller copy is worth making, and its size', () => {
  it('a 1080x1920 video at 8 Mbit/s becomes 480x854 at most 900 kbit/s', () => {
    expect(copyPlan({ width: 1080, height: 1920, duration: 10, bytes: 10_000_000 })).toEqual({ width: 480, height: 854, kbps: 900 })
  })
  it('landscape keeps its shape (short side 480)', () => {
    expect(copyPlan({ width: 1920, height: 1080, duration: 10, bytes: 10_000_000 })).toMatchObject({ width: 854, height: 480 })
  })
  it('an already light video gets none; nonsense input gets none', () => {
    expect(copyPlan({ width: 360, height: 640, duration: 8, bytes: 500_000 })).toBeNull()
    expect(copyPlan({ width: 0, height: 0, duration: 8, bytes: 1 })).toBeNull()
    expect(copyPlan({ width: 1080, height: 1920, duration: Infinity, bytes: 1 })).toBeNull()
  })
  it('a small but heavily encoded video still gets a lighter copy at its own size', () => {
    expect(copyPlan({ width: 480, height: 640, duration: 10, bytes: 5_000_000 })).toEqual({ width: 480, height: 640, kbps: 900 })
  })
})

describe('recorderType', () => {
  it('prefers MP4 (plays everywhere), else WebM, else nothing', () => {
    expect(recorderType(t => t.startsWith('video/mp4'))?.ext).toBe('mp4')
    expect(recorderType(t => t.startsWith('video/webm;codecs="vp9'))?.mime).toBe('video/webm;codecs="vp9,opus"')
    expect(recorderType(() => false)).toBeNull()
  })
})

describe('withWebmDuration: writes the missing Duration into a MediaRecorder-style WebM', () => {
  const bytes = (...xs: number[]) => Uint8Array.from(xs)
  // EBML header (empty), Segment of unknown size, Info { TimecodeScale = 1,000,000 }, Cluster { (empty) }
  const ebml = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x80)
  const segHead = bytes(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)
  const info = bytes(0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40)
  const cluster = bytes(0x1f, 0x43, 0xb6, 0x75, 0x80)
  const file = new Uint8Array([...ebml, ...segHead, ...info, ...cluster])
  const readDuration = (b: Uint8Array) => {
    for (let i = 0; i + 11 <= b.length; i++) if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) return new DataView(b.buffer, b.byteOffset + i + 3, 8).getFloat64(0)
    return null
  }

  it('adds Duration (in timecode-scale units) inside Info and grows Info\'s size; clusters are untouched', () => {
    const out = withWebmDuration(file, 8123)
    expect(readDuration(out)).toBe(8123)
    expect(out.length).toBe(file.length + 11 + 7)                         // the Duration element, and Info's size now 8 bytes
    const infoAt = ebml.length + segHead.length
    expect([...out.subarray(infoAt, infoAt + 4)]).toEqual([0x15, 0x49, 0xa9, 0x66])
    expect(out[infoAt + 4]).toBe(0x01)                                      // 8-byte size
    expect(new DataView(out.buffer, out.byteOffset + infoAt + 5, 7).getUint32(3)).toBe(7 + 11)   // old 7 bytes + Duration
    expect([...out.subarray(out.length - cluster.length)]).toEqual([...cluster])
  })
  it('leaves files that already have a Duration, or are not WebM, unchanged', () => {
    const once = withWebmDuration(file, 5000)
    expect(withWebmDuration(once, 9000)).toBe(once)
    const notWebm = bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70)
    expect(withWebmDuration(notWebm, 1000)).toBe(notWebm)
  })
  it('a known Segment size grows by exactly what was added', () => {
    const known = new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, 0x80 | (info.length + cluster.length), ...info, ...cluster])
    const out = withWebmDuration(known, 1000)
    const segSizeAt = ebml.length + 4
    expect(out[segSizeAt]).toBe(0x01)
    const size = new DataView(out.buffer, out.byteOffset + segSizeAt + 1, 7).getUint32(3)
    expect(size).toBe(out.length - (segSizeAt + 8))
  })
})
