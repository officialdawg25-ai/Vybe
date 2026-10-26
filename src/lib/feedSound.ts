import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * Sound in the feed, Instagram style: one switch for every feed video and every post's song. It starts off (browsers only
 * allow sound after a tap); one tap on any speaker turns it on for the whole feed, and from then on the song of the post
 * you are looking at plays by itself (from the moment its author chose) and stops when you scroll past.
 */
let muted = true
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
export const setFeedMuted = (m: boolean) => { muted = m; if (m) audio?.pause(); else void resume(); emit() }
export const useFeedMuted = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => muted)

/* ---------------------------------------------------------------- one song at a time */
interface Song { src: () => Promise<string | null>; start: number; clip: number }
const songs = new Map<string, Song>()
const ratios = new Map<string, number>()
let audio: HTMLAudioElement | null = null
let owner: string | null = null          // the post whose song is (or would be, when unmuted) playing
let ready: { id: string; url: string } | null = null
let playing = false
const setPlaying = (p: boolean) => { if (playing !== p) { playing = p; emit() } }
export const useFeedSongOwner = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => `${owner ?? ''}|${playing ? 1 : 0}`)

function el() {
  if (audio) return audio
  audio = new Audio(); audio.preload = 'auto'
  audio.addEventListener('timeupdate', () => {
    const s = owner ? songs.get(owner) : null; if (!s || !audio) return
    if (audio.currentTime >= s.start + s.clip || (audio.duration && audio.currentTime >= audio.duration - 0.05)) audio.currentTime = s.start
  })
  audio.addEventListener('playing', () => setPlaying(true))
  audio.addEventListener('pause', () => setPlaying(false))
  return audio
}
/** Start (or continue) the owner's song. Called from a tap too, so it does as little as possible before play(). */
async function resume() {
  const id = owner, s = id ? songs.get(id) : null
  if (!id || !s || muted) return
  const a = el()
  if (ready?.id !== id) {
    const url = await s.src(); if (!url || owner !== id) return
    ready = { id, url }; a.src = url; a.currentTime = s.start
  }
  try { await a.play() } catch { setFeedMuted(true) }         // the browser refused sound without a tap: show the switch as off
}
/** The most-visible post with a song (at least 60% on screen) owns the sound. */
function choose() {
  let best: string | null = null, r = 0.6
  for (const [id, v] of ratios) if (v >= r) { best = id; r = v }
  if (best === owner) return
  owner = best; ready = null
  audio?.pause()
  emit()
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
    return () => { io.disconnect(); ratios.delete(id); songs.delete(id); if (owner === id) { owner = null; ready = null; audio?.pause(); emit() } }
  }, [id, Boolean(song)]) // eslint-disable-line react-hooks/exhaustive-deps
  const [who, on] = key.split('|')
  const active = who === id
  return {
    ref,
    active,
    playing: active && on === '1',
    muted: isMuted,
    /** The speaker on the post: turns the feed's sound on (this post's song plays) or off. */
    toggle: () => { if (isMuted) { owner = id; ready = ready?.id === id ? ready : null; setFeedMuted(false) } else if (active) setFeedMuted(true); else { owner = id; ready = null; emit(); void resume() } },
  }
}
