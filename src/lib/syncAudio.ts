import { useEffect, useRef, useState } from 'react'

/**
 * A post's or reel's song is a separate audio file; the video is the clock. The song never runs on its own:
 *  - it starts only when the video is really playing (the 'playing' event, i.e. frames are moving), never while the video
 *    is still loading, buffering or blocked;
 *  - pause, buffering ('waiting'), an error, 'emptied' or the end of the video pause it at once, and so does a video whose
 *    clock stops moving without saying so (checked every 200 ms);
 *  - after a seek or a loop it jumps to the matching moment of the song;
 *  - while both play, drift is corrected: small offsets by nudging the song's speed (±5 %, inaudible with pitch kept),
 *    larger ones by seeking. Target: under 100 ms of steady offset.
 * Song position = where the creator's chosen moment starts + video time since the trim start (divided by the creator's
 * video speed, because the song was laid at real time), wrapped inside the song's clip so a looping video loops the song
 * with it. If the viewer changes the speed (menu, press-and-hold 2×) the song's own rate follows: video rate ÷ creator speed.
 */
export interface SongClock { start: number; clip: number; trimStart?: number; speed?: number; duration?: number }
export const DRIFT_SEEK_S = 0.25
export const DRIFT_NUDGE_S = 0.04
export const STALL_MS = 400

export function songTimeFor(videoT: number, c: SongClock): number {
  const off = Math.max(0, videoT - (c.trimStart ?? 0)) / (c.speed && c.speed > 0 ? c.speed : 1)
  const room = c.duration && Number.isFinite(c.duration) ? Math.max(0.5, c.duration - c.start) : Infinity
  const clip = Math.min(c.clip > 0 ? c.clip : Infinity, room)
  return c.start + (Number.isFinite(clip) ? off % clip : off)
}

export interface SongBinding { detach: () => void; refresh: () => void }

/** Ties `audio` to `video` as described above. `canPlay` says whether sound is wanted at all (not muted, still current). */
export function bindSong(video: HTMLVideoElement, audio: HTMLAudioElement, clock: () => SongClock, opts: { canPlay: () => boolean; onBlocked?: (blocked: boolean) => void }): SongBinding {
  const expected = () => songTimeFor(video.currentTime, { ...clock(), duration: audio.duration })
  const align = () => { const e = expected(); if (Math.abs(audio.currentTime - e) > 0.03) { try { audio.currentTime = e } catch { /* not seekable yet */ } } }
  const videoRunning = () => !video.paused && !video.ended && video.readyState >= 3 && !video.seeking
  const base = () => { const c = clock().speed; return Math.min(4, Math.max(0.25, (video.playbackRate || 1) / (c && c > 0 ? c : 1))) }
  const start = () => {
    if (!opts.canPlay() || !videoRunning()) { audio.pause(); return }
    align(); audio.playbackRate = base()
    void audio.play().then(() => opts.onBlocked?.(false), () => opts.onBlocked?.(true))
  }
  const stop = () => { if (!audio.paused) audio.pause() }
  const onTime = () => {
    if (audio.paused || !videoRunning()) return
    const d = audio.currentTime - expected()
    if (Math.abs(d) > DRIFT_SEEK_S) align()
    else if (Math.abs(d) > DRIFT_NUDGE_S) audio.playbackRate = base() * (d > 0 ? 0.95 : 1.05)
    else if (audio.playbackRate !== base()) audio.playbackRate = base()
  }
  const onRate = () => { align(); audio.playbackRate = base() }
  const onSeeked = () => { align(); if (videoRunning()) start() }
  const on: [string, () => void][] = [['playing', start], ['pause', stop], ['waiting', stop], ['seeking', stop], ['seeked', onSeeked], ['error', stop], ['emptied', stop], ['ended', stop], ['timeupdate', onTime], ['ratechange', onRate]]
  for (const [e, f] of on) video.addEventListener(e, f)
  // Watchdog: a video can freeze without firing 'waiting' (and then fires no 'timeupdate' either), so every 200 ms check
  // that its clock still moves; if not, hold the song until it does. Also runs the drift check on that tick.
  let lastT = video.currentTime, lastMove = performance.now(), held = false
  const dog = window.setInterval(() => {
    const now = performance.now()
    if (video.currentTime !== lastT) {
      lastT = video.currentTime; lastMove = now
      if (held) { held = false; start() } else onTime()
    } else if (!audio.paused && !video.paused && now - lastMove > STALL_MS) { held = true; stop() }
  }, 200)
  if (videoRunning()) start(); else stop()
  return {
    detach: () => { window.clearInterval(dog); for (const [e, f] of on) video.removeEventListener(e, f); stop() },
    refresh: () => (videoRunning() ? start() : stop()),
  }
}

/* ---------------------------------------------------------------- page-wide: nothing plays in a hidden tab */
const extra = new Set<HTMLMediaElement>()
/** Audio elements that are not in the page (songs) register here so leaving the tab silences them too. */
export const trackAudio = (a: HTMLMediaElement) => { extra.add(a); return () => { extra.delete(a) } }
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return
    document.querySelectorAll('video, audio').forEach(m => (m as HTMLMediaElement).pause())
    extra.forEach(m => m.pause())
  })
}

/**
 * A reel's song as a hook: one audio element per song (released when the reel stops being current), bound to the video
 * element passed in. `enabled` = this reel is the current one; `muted` = the viewer's sound switch.
 */
export function useVideoSong(video: HTMLVideoElement | null, src: string | null, o: { enabled: boolean; muted: boolean; volume?: number; start_ms: number; clip_ms: number; trim_start_ms?: number; speed?: number }) {
  const [blocked, setBlocked] = useState(false)
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
  const opt = useRef(o); opt.current = o
  const binding = useRef<SongBinding | null>(null)
  useEffect(() => {
    if (!src || !o.enabled) return
    const a = new Audio(); a.preload = 'auto'; a.src = src
    const untrack = trackAudio(a)
    setAudio(a)
    return () => { a.pause(); untrack(); a.removeAttribute('src'); a.load(); setAudio(null) }
  }, [src, o.enabled])
  useEffect(() => {
    if (!video || !audio) return
    const b = bindSong(video, audio, () => ({ start: opt.current.start_ms / 1000, clip: opt.current.clip_ms / 1000, trimStart: (opt.current.trim_start_ms ?? 0) / 1000, speed: opt.current.speed ?? 1 }),
      { canPlay: () => opt.current.enabled && !opt.current.muted, onBlocked: setBlocked })
    binding.current = b
    return () => { b.detach(); binding.current = null }
  }, [video, audio])
  useEffect(() => { if (audio) { audio.muted = o.muted; audio.volume = Math.max(0, Math.min(1, o.volume ?? 1)) } binding.current?.refresh() }, [audio, o.muted, o.volume])
  return { blocked, audio, unblock: () => binding.current?.refresh() }
}
