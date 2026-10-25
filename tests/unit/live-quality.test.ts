import { describe, expect, it } from 'vitest'
import { PROFILES, captureSize, chooseProfile, readLiveStats, sizeLabel, summarize } from '../../src/lib/liveQuality'
import { resolvePolicy, type Conditions } from '../../src/lib/dataMode'

const fast: Conditions = { saveData: false, effectiveType: '4g', cores: 8, memoryGb: 8, reducedMotion: false }

describe('live quality profile', () => {
  it('asks for Full HD only on a capable device without data saver', () => {
    expect(chooseProfile('auto', 'auto', fast)).toBe('fhd')
    expect(chooseProfile('auto', 'auto', { ...fast, cores: 4, memoryGb: 4 })).toBe('hd')
    expect(chooseProfile('auto', 'high', { ...fast, cores: 4, memoryGb: 4 })).toBe('fhd')            // the member asked for it
    expect(chooseProfile('auto', 'auto', { ...fast, memoryGb: 2 })).toBe('hd')
    expect(chooseProfile('auto', 'device', fast)).toBe('hd')
  })
  it('steps down for data saver and slow connections', () => {
    expect(chooseProfile('auto', 'saver', fast)).toBe('sd')
    expect(chooseProfile('auto', 'auto', { ...fast, saveData: true })).toBe('sd')
    expect(chooseProfile('auto', 'auto', { ...fast, effectiveType: '3g' })).toBe('sd')
    expect(chooseProfile('auto', 'auto', { ...fast, effectiveType: 'slow-2g' })).toBe('low')
  })
  it('an explicit choice wins', () => { expect(chooseProfile('low', 'high', fast)).toBe('low'); expect(chooseProfile('fhd', 'saver', fast)).toBe('fhd') })
  it('1080p publishes 720p and 360p layers below it; the lowest profile publishes a single layer', () => {
    expect(PROFILES.fhd).toMatchObject({ width: 1920, height: 1080, fps: 30 })
    expect(PROFILES.fhd.layers.map(l => PROFILES[l].height)).toEqual([360, 720])
    expect(PROFILES.low.layers).toEqual([])
  })
  it('portrait phones ask for a portrait frame', () => {
    expect(captureSize(PROFILES.fhd, true)).toEqual({ width: 1080, height: 1920 })
    expect(captureSize(PROFILES.fhd, false)).toEqual({ width: 1920, height: 1080 })
  })
})

describe('live statistics are measured, never assumed', () => {
  const sample = (at: number, bytes: [string, number][], frames: number | null = null, recvBytes: number | null = null, lost: number | null = null, recv: number | null = null) => ({ at, bytes: new Map(bytes), frames, recvBytes, lost, recv })
  it('reports each layer at its encoded size and bitrate between two samples', () => {
    const prev = sample(0, [['f', 0], ['h', 0]])
    const cur = sample(2000, [['f', 750_000], ['h', 250_000]])
    const s = summarize(prev, cur, { capture: { width: 1080, height: 1920 }, rttMs: 40, received: null,
      layers: [{ rid: 'h', width: 360, height: 640, fps: 30, bytes: 250_000 }, { rid: 'f', width: 1080, height: 1920, fps: 29.6, bytes: 750_000, limitedBy: 'bandwidth' }] })
    expect(s.sent[0]).toEqual({ rid: 'f', width: 1080, height: 1920, fps: 30, kbps: 3000, limitedBy: 'bandwidth' })
    expect(s.sent[1].kbps).toBe(1000)
    expect(s.capture).toEqual({ width: 1080, height: 1920 })
  })
  it('the first sample has no rates yet (nothing is invented)', () => {
    const s = summarize(null, sample(0, [['f', 10]]), { capture: null, rttMs: null, received: null, layers: [{ rid: 'f', width: 1280, height: 720, fps: 30, bytes: 10 }] })
    expect(s.sent[0].kbps).toBeNull()
  })
  it('a viewer sees received size, frame rate, bitrate and packet loss', () => {
    const prev = sample(0, [], 0, 0, 0, 0)
    const cur = sample(1000, [], 30, 250_000, 5, 495)
    const s = summarize(prev, cur, { capture: null, layers: [], rttMs: null, received: { width: 1280, height: 720, framesDecoded: 30, dropped: 1, jitter: 0.012 } })
    expect(s.received).toEqual({ width: 1280, height: 720, fps: 30, kbps: 2000, lossPct: 1, jitterMs: 12, dropped: 1 })
  })
  it('lists a paused layer as paused (never as sent) and survives stats errors', async () => {
    const local = { dimensions: { width: 1920, height: 1080 }, getSenderStats: async () => [{ rid: 'f', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30, bytesSent: 100 }, { rid: 'q', frameWidth: 0, frameHeight: 0, framesPerSecond: 0 }] }
    const r1 = await readLiveStats(local, null, null)
    expect(r1.stats.sent.map(l => [l.rid, Boolean(l.paused)])).toEqual([['f', false], ['q', true]])
    expect(r1.stats.sent[1]).toMatchObject({ width: 0, height: 0, kbps: null })
    const broken = { getReceiverStats: async () => { throw new Error('closed') } }
    const r2 = await readLiveStats(null, broken as never, null)
    expect(r2.stats.received).toBeNull()
  })
  it('labels sizes by their shorter side', () => { expect(sizeLabel({ width: 1080, height: 1920 })).toBe('1080 × 1920 (1080p)'); expect(sizeLabel(null)).toBe('not measured yet') })
})

describe('data modes', () => {
  it('automatic follows the browser’s data saver and slow connections', () => {
    expect(resolvePolicy('auto', fast)).toMatchObject({ saver: false, prefetchNextVideo: true, autoplayFeedVideo: true })
    expect(resolvePolicy('auto', { ...fast, saveData: true })).toMatchObject({ saver: true, prefetchNextVideo: true, autoplayFeedVideo: false, pageMargin: '300px 0px' })
    expect(resolvePolicy('auto', { ...fast, effectiveType: '3g' }).saver).toBe(true)
  })
  it('device saver skips preparing the next reel; high quality ignores the browser hints', () => {
    expect(resolvePolicy('device', fast)).toMatchObject({ lowEnd: true, prefetchNextVideo: false })
    expect(resolvePolicy('high', { ...fast, saveData: true, memoryGb: 1 })).toMatchObject({ saver: false, lowEnd: false, prefetchNextVideo: true })
  })
})
