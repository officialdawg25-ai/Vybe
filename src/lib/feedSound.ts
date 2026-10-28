import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { bindSong, trackAudio, type SongBinding } from './syncAudio'

/**
 * Sound in the feed, Instagram style: one switch for every feed video and every post's song. It starts off (browsers only
 * allow sound after a tap); one tap on any speaker turns it on for the whole feed, and from then on the song of the post
 * you are looking at plays by itself (from the moment its author chose) and stops when you scroll past.
 * When the post shows a video, that video is the song's clock (lib/syncAudio): the song waits for the video's first frames,
 * pauses whenever the video pauses or buffers, and follows its seeks and loops. A photo post's song simply plays.
 */
let muted = true
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
export const setFeedMuted = (m: boolean) => { muted = m; if (m) audio?.pause(); else void resume(); emit() }
export const useFeedMuted = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => muted)

/* ---------------------------------------------------------------- one song at a time */
interface Song { src: () => Promise<string | null>; start: number; clip: number; title?: string | null; artist?: string | null; artwork?: string | null }
const songs = new Map<string, Song>()
const ratios = new Map<string, number>()
let audio: HTMLAudioElement | null = null
let owner: string | null = null          // the post whose song is (or would be, when unmuted) playing
let ready: { id: string; url: string } | null = null
let playing = false
const clocks = new Map<string, HTMLVideoElement>()   // post → the video currently shown on it (its active slide)
let binding: SongBinding | null = null
const setPlaying = (p: boolean) => { if (playing !== p) { playing = p; emit(); session() } }
export const useFeedSongOwner = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => `${owner ?? ''}|${playing ? 1 : 0}`)

function el() {
  if (audio) return audio
  audio = new Audio(); audio.preload = 'auto'; trackAudio(audio)
  audio.addEventListener('timeupdate', () => {
    const s = owner ? songs.get(owner) : null; if (!s || !audio || binding) return   // a bound song loops with its video
    if (audio.currentTime >= s.start + s.clip || (audio.duration && audio.currentTime >= audio.duration - 0.05)) audio.currentTime = s.start
  })
  audio.addEventListener('playing', () => setPlaying(true))
  audio.addEventListener('pause', () => setPlaying(false))
  return audio
}
/** Ties the song to the owner's video, if it shows one; otherwise nothing is bound and the song plays freely. */
function rebind() {
  binding?.detach(); binding = null
  const id = owner, v = id ? clocks.get(id) : undefined, s = id ? songs.get(id) : undefined
  if (!id || !v || !s || !audio || ready?.id !== id) return
  binding = bindSong(v, audio, () => ({ start: s.start, clip: s.clip }), { canPlay: () => owner === id && !held, onBlocked: () => { /* waits for the next tap anywhere (see wake below) */ } })
}
/** Start (or continue) the owner's song. Called from a tap too, so it does as little as possible before play(). */
async function resume() {
  const id = owner, s = id ? songs.get(id) : null
  if (!id || !s || held) return
  const a = el()
  applyLevel()
  if (ready?.id !== id) {
    const url = await s.src(); if (!url || owner !== id) return
    ready = { id, url }; a.src = url; a.currentTime = s.start
    rebind()
  }
  if (!binding) rebind()                                      // after a deliberate pause the binding was released
  if (binding) { binding.refresh(); return }                  // plays only once (and while) the video really plays
  try { await a.play() } catch { /* the browser wants a tap first: the next tap anywhere starts it (wake below) */ }
}
/** PostMedia reports the video on screen for a post (null for a photo); the song follows it. */
export function setFeedClock(id: string, v: HTMLVideoElement | null) {
  if ((clocks.get(id) ?? null) === v) return
  if (v) clocks.set(id, v); else clocks.delete(id)
  if (owner !== id) return
  rebind()
  if (!binding && !held && ready?.id === id) void audio?.play().catch(() => {})
}
/**
 * Songs play by themselves while their post is on screen (there is no speaker button to press). Browsers only allow sound
 * after the person has touched the page once, so a refused start is retried on every tap or key press until it works.
 *
 * Volume and the phone's own controls ("special handling"):
 *  - The song is a normal media element, so the phone's volume buttons change its loudness like any music app.
 *  - It also registers with the Media Session: the lock screen / notification shade / headphones show the song's title,
 *    artist and artwork, and their play, pause, next and previous buttons work (next / previous move to the next or
 *    previous post with a song). Pausing there is respected: the feed does not start it again until you press play or a
 *    different post becomes the one on screen.
 *  - Keyboards with media keys (and remote controls that send them): volume up / down change the feed's song volume in
 *    steps of 10 % (remembered on this device) and mute toggles it; a small indicator shows the level.
 * Browsers do not tell web pages when the hardware volume buttons are pressed, so the page never reads or changes the
 * phone's own volume.
 */
let held = false                                     // paused on purpose (media controls or the mute key)
const LEVEL_KEY = 'vybe:song-volume'
let level = (() => { try { const v = Number(localStorage.getItem(LEVEL_KEY)); return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1 } catch { return 1 } })()
let silenced = false
function applyLevel() { if (audio) { audio.volume = level; audio.muted = silenced } }
export const songLevel = () => ({ level, muted: silenced, held })
let hud: HTMLDivElement | null = null, hudTimer = 0
function showLevel() {
  if (typeof document === 'undefined') return
  if (!hud) { hud = document.createElement('div'); hud.className = 'vol-hud'; hud.setAttribute('role', 'status'); hud.setAttribute('aria-live', 'polite'); document.body.appendChild(hud) }
  const pct = silenced ? 0 : Math.round(level * 100)
  hud.innerHTML = `<span class="vol-hud-ico" aria-hidden="true">${pct === 0 ? '🔇' : pct < 50 ? '🔉' : '🔊'}</span><span class="vol-hud-bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="sr-only">Song volume ${pct} percent</span>`
  hud.classList.add('on'); window.clearTimeout(hudTimer); hudTimer = window.setTimeout(() => hud?.classList.remove('on'), 1300)
}
function setLevel(next: number) {
  level = Math.round(Math.min(1, Math.max(0, next)) * 10) / 10
  silenced = level === 0
  if (level > 0) { try { localStorage.setItem(LEVEL_KEY, String(level)) } catch { /* not remembered */ } }
  applyLevel(); showLevel()
  if (!silenced && owner && audio?.paused && !held) { if (binding) binding.refresh(); else void resume() }
}
function hold(on: boolean) {
  held = on
  if (on) { binding?.detach(); binding = null; audio?.pause() }
  else void resume()                                   // same file, same moment: no reload
  session()
}
/** Next / previous post that has a song, for the lock-screen and headphone buttons. */
function step(dir: 1 | -1) {
  if (typeof document === 'undefined') return
  const cards = [...document.querySelectorAll<HTMLElement>('[data-song-post]')]
  const i = cards.findIndex(c => c.dataset.songPost === owner)
  const next = cards[i + dir] ?? null
  next?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
/** Tells the phone what is playing, and wires its buttons. */
function session() {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
  if (!ms) return
  const s = owner ? songs.get(owner) : null
  try {
    if (s && typeof MediaMetadata !== 'undefined') ms.metadata = new MediaMetadata({ title: s.title || 'Song', artist: s.artist || 'VYBE', album: 'VYBE', artwork: s.artwork ? [{ src: s.artwork, sizes: '512x512' }] : [] })
    ms.playbackState = !s ? 'none' : held || !playing ? 'paused' : 'playing'
  } catch { /* some browsers have a partial Media Session */ }
}
if (typeof window !== 'undefined') {
  const wake = (e: Event) => {
    if (e.type === 'keydown') {
      const k = (e as KeyboardEvent).key
      if (k === 'AudioVolumeUp' || k === 'VolumeUp') { if (held) hold(false); setLevel((silenced ? 0 : level) + 0.1); return }
      if (k === 'AudioVolumeDown' || k === 'VolumeDown') { setLevel(level - 0.1); return }
      if (k === 'AudioVolumeMute' || k === 'VolumeMute') { if (held || silenced) { silenced = false; if (level === 0) level = 0.5; applyLevel(); hold(false) } else { silenced = true; applyLevel(); hold(true) } showLevel(); return }
    }
    if (held) return                                                    // a deliberate pause is not undone by an ordinary tap
    if (owner && audio && audio.paused) { applyLevel(); if (binding) binding.refresh(); else void resume() } else if (owner && !audio) void resume()
  }
  for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, wake, { passive: true, capture: true })
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
  const on = (a: MediaSessionAction, f: MediaSessionActionHandler) => { try { ms?.setActionHandler(a, f) } catch { /* action not supported */ } }
  on('play', () => hold(false)); on('pause', () => hold(true)); on('stop', () => hold(true))
  on('nexttrack', () => step(1)); on('previoustrack', () => step(-1))
}
/** The most-visible post with a song (at least 60% on screen) owns the sound. */
function choose() {
  let best: string | null = null, r = 0.6
  for (const [id, v] of ratios) if (v >= r) { best = id; r = v }
  if (best === owner) return
  owner = best; ready = null; held = false
  binding?.detach(); binding = null
  audio?.pause()
  emit(); session()
  if (best) void resume()
}

/** Attach to a post with a song: plays it while it is the post on screen and the feed's sound is on. */
export function useFeedSong(id: string, song: Song | null) {
  const ref = useRef<HTMLElement | null>(null)
  const key = useFeedSongOwner()
  const isMuted = useFeedMuted()
  const [, force] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!song || !node || typeof IntersectionObserver === 'undefined') return
    songs.set(id, song)
    const io = new IntersectionObserver(([e]) => { ratios.set(id, e.isIntersecting ? e.intersectionRatio : 0); choose() }, { threshold: [0, 0.3, 0.6, 0.8, 1] })
    io.observe(node)
    force(n => n + 1)
    return () => { io.disconnect(); ratios.delete(id); songs.delete(id); clocks.delete(id); if (owner === id) { owner = null; ready = null; binding?.detach(); binding = null; audio?.pause(); emit() } }
  }, [id, Boolean(song)]) // eslint-disable-line react-hooks/exhaustive-deps
  const [who, on] = key.split('|')
  const active = who === id
  return {
    ref,
    active,
    playing: active && on === '1',
    muted: isMuted,
    /** Kept for callers that still want it; the post card no longer shows a speaker. */
    toggle: () => { if (isMuted) { if (owner !== id) { binding?.detach(); binding = null } owner = id; ready = ready?.id === id ? ready : null; setFeedMuted(false) } else if (active) setFeedMuted(true); else { binding?.detach(); binding = null; owner = id; ready = null; emit(); void resume() } },
  }
}
