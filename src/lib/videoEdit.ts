/**
 * The composer's video editor settings. Editing is non-destructive: the original file is uploaded untouched and these choices
 * are stored beside it (post_media.trim_start_ms / trim_end_ms / muted), then applied when the video plays.
 */
export interface VideoEdit { start: number; end: number; muted: boolean }      // seconds

export const MIN_CLIP = 0.5

/** What goes into post_media for a video, or nothing when the whole video plays with its own sound. */
export function editColumns(e: VideoEdit | null | undefined, duration: number | null | undefined): { trim_start_ms?: number; trim_end_ms?: number; muted?: boolean } {
  if (!e) return {}
  const out: { trim_start_ms?: number; trim_end_ms?: number; muted?: boolean } = {}
  const dur = duration && Number.isFinite(duration) ? duration : null
  const start = Math.max(0, e.start), end = dur ? Math.min(dur, e.end) : e.end
  const trimmed = dur ? start > 0.05 || end < dur - 0.05 : false
  if (trimmed && end - start >= MIN_CLIP) { out.trim_start_ms = Math.round(start * 1000); out.trim_end_ms = Math.round(end * 1000) }
  if (e.muted) out.muted = true
  return out
}

/** Keeps a trim valid after a handle moves: inside the video, in order, at least MIN_CLIP long. */
export function clampTrim(start: number, end: number, duration: number, moved: 'start' | 'end'): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, duration)), e = Math.max(0, Math.min(end, duration))
  if (e - s < MIN_CLIP) { if (moved === 'start') s = Math.max(0, e - MIN_CLIP); else e = Math.min(duration, s + MIN_CLIP) }
  return { start: s, end: e }
}

export const clock = (sec: number) => { const s = Math.max(0, sec); const m = Math.floor(s / 60); const r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}` }

/** A strip of small frames across the video for the timeline. Resolves to fewer (or no) frames if the browser cannot seek. */
export async function frameStrip(url: string, duration: number, n = 8): Promise<string[]> {
  const v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
  try {
    await new Promise<void>((ok, bad) => { v.onloadeddata = () => ok(); v.onerror = () => bad(new Error('unreadable')); setTimeout(() => bad(new Error('slow')), 8000) })
    const w = 72, h = Math.round(w * (v.videoHeight / (v.videoWidth || 1))) || 96
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const g = c.getContext('2d'); if (!g) return []
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.min(duration - 0.05, ((i + 0.5) / n) * duration)
      await new Promise<void>(ok => { const t = setTimeout(ok, 1200); v.onseeked = () => { clearTimeout(t); ok() } })
      g.drawImage(v, 0, 0, w, h); out.push(c.toDataURL('image/jpeg', 0.6))
    }
    return out
  } catch { return [] } finally { v.removeAttribute('src'); v.load() }
}
