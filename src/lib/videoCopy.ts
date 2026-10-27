/**
 * The smaller playback copy of a video (at most 480p), made on the uploader's device AFTER the post is published, so
 * viewers get a real quality choice (lib/videoQuality) without any server-side transcoding. Publishing never waits for
 * it and nothing fails without it: if the device cannot make a good copy, the post simply has the original only.
 *
 * How: the original plays once, hidden and silent to the speakers, while its frames are drawn onto a smaller canvas and
 * its sound is routed through Web Audio into a MediaRecorder. So it takes as long as the video lasts (reels are short).
 * The result is checked before it is used: it must load, last as long as the original, seek, and be clearly smaller.
 * Chrome's WebM recordings carry no duration (players then show no length and seek poorly), so it is written in.
 */

export const COPY_SHORT_SIDE = 480
export const COPY_KBPS = 900
/** Size and bitrate of the copy for a video, or null when the original is already small enough to need none. */
export function copyPlan(v: { width: number; height: number; duration: number; bytes: number }): { width: number; height: number; kbps: number } | null {
  if (!v.width || !v.height || !Number.isFinite(v.duration) || v.duration <= 0) return null
  const short = Math.min(v.width, v.height)
  const kbps = (v.bytes * 8) / 1000 / v.duration
  if (short <= 540 && kbps <= 1600) return null                         // already light: a copy would save little
  const k = Math.min(1, COPY_SHORT_SIDE / short)
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { width: even(v.width * k), height: even(v.height * k), kbps: Math.min(COPY_KBPS, Math.round(kbps * 0.6)) }
}

/** The recording format: MP4 where the browser can record it (plays everywhere), otherwise WebM. */
export function recorderType(supported: (t: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } | null {
  for (const t of ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4']) if (supported(t)) return { mime: t, ext: 'mp4' }
  for (const t of ['video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm']) if (supported(t)) return { mime: t, ext: 'webm' }
  return null
}

/* ---------------------------------------------------------------- WebM duration (EBML) */
const SEGMENT = 0x18538067, INFO = 0x1549a966, DURATION = 0x4489, TIMECODE_SCALE = 0x2ad7b1, CLUSTER = 0x1f43b675, EBML = 0x1a45dfa3

function readId(b: Uint8Array, p: number): { id: number; len: number } | null {
  const first = b[p]; if (first === undefined || first === 0) return null
  let len = 1; while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 4 || p + len > b.length) return null
  let id = 0; for (let i = 0; i < len; i++) id = id * 256 + b[p + i]
  return { id, len }
}
function readSize(b: Uint8Array, p: number): { size: number; len: number; unknown: boolean } | null {
  const first = b[p]; if (first === undefined || first === 0) return null
  let len = 1; while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8 || p + len > b.length) return null
  let size = first & (0xff >> len), allOnes = size === (0xff >> len)
  for (let i = 1; i < len; i++) { size = size * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false }
  return { size, len, unknown: allOnes }
}
const size8 = (n: number) => { const out = new Uint8Array(8); out[0] = 0x01; for (let i = 7; i >= 1; i--) { out[i] = n % 256; n = Math.floor(n / 256) } return out }
const uint = (b: Uint8Array, p: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v }

/** Writes the Duration into a WebM file's Segment Info when it is missing. Returns the input unchanged if it has one
 *  already or the layout is not the simple one MediaRecorder writes (EBML header, Segment, Info before any Cluster). */
export function withWebmDuration(b: Uint8Array, durationMs: number): Uint8Array {
  let p = 0
  const head = readId(b, p); if (!head || head.id !== EBML) return b
  const hs = readSize(b, p + head.len); if (!hs) return b
  p += head.len + hs.len + hs.size
  const seg = readId(b, p); if (!seg || seg.id !== SEGMENT) return b
  const segSizeAt = p + seg.len, ss = readSize(b, segSizeAt); if (!ss) return b
  const segData = segSizeAt + ss.len
  for (let q = segData; q < b.length;) {
    const el = readId(b, q); if (!el) return b
    const es = readSize(b, q + el.len); if (!es || es.unknown) return b
    const dataAt = q + el.len + es.len
    if (el.id === CLUSTER) return b
    if (el.id === INFO) {
      let scale = 1_000_000
      for (let r = dataAt; r < dataAt + es.size;) {
        const c = readId(b, r); if (!c) return b
        const cs = readSize(b, r + c.len); if (!cs) return b
        if (c.id === DURATION) return b                                       // already there
        if (c.id === TIMECODE_SCALE) scale = uint(b, r + c.len + cs.len, cs.size) || scale
        r += c.len + cs.len + cs.size
      }
      const dur = new Uint8Array(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88
      new DataView(dur.buffer).setFloat64(3, (durationMs * 1_000_000) / scale)
      const infoSize = size8(es.size + dur.length)
      const growth = infoSize.length - es.len + dur.length
      const segSize = ss.unknown ? b.subarray(segSizeAt, segData) : size8(ss.size + growth)
      const parts = [b.subarray(0, segSizeAt), segSize, b.subarray(segData, q + el.len), infoSize, b.subarray(dataAt, dataAt + es.size), dur, b.subarray(dataAt + es.size)]
      const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
      let o = 0; for (const x of parts) { out.set(x, o); o += x.length }
      return out
    }
    q = dataAt + es.size
  }
  return b
}

/* ---------------------------------------------------------------- making the copy (browser only) */
const loaded = (v: HTMLVideoElement, ev: string, ms = 10_000) => new Promise<void>((res, rej) => {
  const t = window.setTimeout(() => rej(new Error('timeout')), ms)
  v.addEventListener(ev, () => { window.clearTimeout(t); res() }, { once: true })
  v.addEventListener('error', () => { window.clearTimeout(t); rej(new Error('decode')) }, { once: true })
})

/** Plays `file` once into a smaller recording. Resolves null when not possible here or not worth it. */
export async function makeSmallCopy(file: Blob, signal?: AbortSignal): Promise<{ blob: Blob; ext: 'mp4' | 'webm'; width: number; height: number } | null> {
  if (typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null
  const type = recorderType(t => MediaRecorder.isTypeSupported(t)); if (!type) return null
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.playsInline = true; v.preload = 'auto'; v.src = url
  let ctx: AudioContext | null = null
  try {
    await loaded(v, 'loadedmetadata')
    const plan = copyPlan({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, bytes: file.size }); if (!plan) return null
    const canvas = document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height
    const g = canvas.getContext('2d'); if (!g) return null
    // Sound goes only into the recording: once routed through Web Audio, the element no longer plays to the speakers.
    ctx = new AudioContext()
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    if (ctx.state !== 'running') return null                              // no sound capture now: no copy rather than a silent one
    const out = ctx.createMediaStreamDestination()
    ctx.createMediaElementSource(v).connect(out)
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...out.stream.getAudioTracks()])
    const rec = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: plan.kbps * 1000, audioBitsPerSecond: 96_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    const done = new Promise<void>(res => { rec.onstop = () => res() })
    let stop = false
    const paint = () => { if (stop) return; g.drawImage(v, 0, 0, plan.width, plan.height); if ('requestVideoFrameCallback' in v) (v as HTMLVideoElement & { requestVideoFrameCallback: (f: () => void) => void }).requestVideoFrameCallback(paint); else requestAnimationFrame(paint) }
    const abort = () => { stop = true; if (rec.state !== 'inactive') rec.stop() }
    signal?.addEventListener('abort', abort)
    const hidden = () => { if (document.hidden) abort() }                 // background tabs drop frames: give up instead
    document.addEventListener('visibilitychange', hidden)
    try {
      rec.start(1000)
      paint()
      await v.play()
      const limit = window.setTimeout(abort, (v.duration * 1.5 + 15) * 1000)
      await Promise.race([loaded(v, 'ended', (v.duration * 2 + 20) * 1000).catch(() => {}), done])
      window.clearTimeout(limit)
      stop = true
      if (rec.state !== 'inactive') rec.stop()
      await done
    } finally {
      signal?.removeEventListener('abort', abort); document.removeEventListener('visibilitychange', hidden)
    }
    if (signal?.aborted || document.hidden || !v.ended) return null
    let blob = new Blob(chunks, { type: type.ext === 'mp4' ? 'video/mp4' : 'video/webm' })
    if (type.ext === 'webm') blob = new Blob([withWebmDuration(new Uint8Array(await blob.arrayBuffer()), v.duration * 1000) as Uint8Array<ArrayBuffer>], { type: 'video/webm' })
    if (blob.size > file.size * 0.65) return null                         // not clearly smaller: keep the original only
    return (await checkCopy(blob, v.duration)) ? { blob, ext: type.ext, width: plan.width, height: plan.height } : null
  } catch { return null } finally {
    v.pause(); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); void ctx?.close().catch(() => {})
  }
}

/** A copy is used only if it loads, lasts as long as the original (within a second) and can seek to its middle. */
export async function checkCopy(blob: Blob, duration: number): Promise<boolean> {
  const url = URL.createObjectURL(blob), v = document.createElement('video')
  v.muted = true; v.preload = 'metadata'; v.src = url
  try {
    await loaded(v, 'loadedmetadata')
    if (!Number.isFinite(v.duration) || Math.abs(v.duration - duration) > 1 || !v.videoWidth) return false
    v.currentTime = duration / 2
    await loaded(v, 'seeked')
    return true
  } catch { return false } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url) }
}
