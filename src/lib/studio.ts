import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { signedUrl } from './media'
import { brandUrl } from './social'
import { isMissingSchema } from './tickets'

/**
 * The creative studio shared by memories and reels: filters, overlays (text, stickers, @mentions, drawing), the song and
 * where it starts, reel playback settings and camera preferences. Everything here is presentation stored as small JSON
 * next to the record; the picture or video file itself is never re-encoded, so the original quality is kept.
 */

/* ---------------------------------------------------------------- filters */
export const FILTERS = [
  { key: 'none', label: 'Original', css: 'none' },
  { key: 'vivid', label: 'Vivid', css: 'saturate(1.45) contrast(1.08)' },
  { key: 'warm', label: 'Golden', css: 'sepia(.28) saturate(1.3) hue-rotate(-8deg) brightness(1.04)' },
  { key: 'cool', label: 'Cool', css: 'saturate(1.1) hue-rotate(14deg) brightness(1.03) contrast(1.04)' },
  { key: 'film', label: 'Film', css: 'sepia(.18) contrast(.92) brightness(1.06) saturate(.9)' },
  { key: 'fade', label: 'Fade', css: 'contrast(.82) brightness(1.12) saturate(.78)' },
  { key: 'dream', label: 'Dream', css: 'saturate(1.25) brightness(1.1) contrast(.9) hue-rotate(-12deg)' },
  { key: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.05)' },
  { key: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.45) brightness(.9)' },
] as const
export type FilterKey = (typeof FILTERS)[number]['key']
export const filterCss = (k?: string | null) => FILTERS.find(f => f.key === k)?.css ?? 'none'
export const isFilter = (k: unknown): k is FilterKey => FILTERS.some(f => f.key === k)

/* ---------------------------------------------------------------- overlays */
/** Positions are fractions of the stage (0–1), so an overlay lands in the same place on every screen size. */
export type TextStyle = 'classic' | 'bold' | 'serif' | 'type' | 'neon'
export interface TextOverlay { t: 'text'; id: string; text: string; x: number; y: number; size: number; color: string; style: TextStyle; bg: boolean }
export interface StickerOverlay { t: 'sticker'; id: string; emoji: string; x: number; y: number; size: number }
export interface MentionOverlay { t: 'mention'; id: string; uid: string; username: string; x: number; y: number; size: number }
/** One stroke: points as integers 0–1000 (x, y, x, y…), so a full drawing stays small. */
export interface DrawOverlay { t: 'draw'; id: string; color: string; width: number; pts: number[]; glow?: boolean }
export type Overlay = TextOverlay | StickerOverlay | MentionOverlay | DrawOverlay
export type Placed = Exclude<Overlay, DrawOverlay>

export const TEXT_STYLES: { key: TextStyle; label: string }[] = [
  { key: 'classic', label: 'Classic' }, { key: 'bold', label: 'Strong' }, { key: 'serif', label: 'Editor' }, { key: 'type', label: 'Typewriter' }, { key: 'neon', label: 'Neon' },
]
export const INK = ['#ffffff', '#111111', '#ff3b5c', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#8c76ff', '#ff6ad5']
export const STICKERS = ['🎓', '🎉', '🔥', '❤️', '✨', '😂', '🥳', '😍', '🙌', '💯', '🌅', '🎶', '🎧', '📍', '☀️', '🌙', '🍾', '🏆', '👑', '💜', '😎', '🤍', '🫶', '⚡']
export const newId = () => Math.random().toString(36).slice(2, 10)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Keeps only well-formed overlays (they come back from the server as JSON anyone could have written). */
export function cleanOverlays(raw: unknown): Overlay[] {
  if (!Array.isArray(raw)) return []
  const out: Overlay[] = []
  for (const o of raw.slice(0, 60)) {
    if (!o || typeof o !== 'object') continue
    const r = o as Record<string, unknown>, id = String(r.id ?? newId()).slice(0, 16)
    const x = clamp(Number(r.x) || 0.5, 0, 1), y = clamp(Number(r.y) || 0.5, 0, 1), size = clamp(Number(r.size) || 1, 0.4, 3)
    if (r.t === 'text' && typeof r.text === 'string' && r.text.trim()) out.push({ t: 'text', id, text: r.text.slice(0, 300), x, y, size, color: safeColor(r.color), style: TEXT_STYLES.some(s => s.key === r.style) ? r.style as TextStyle : 'classic', bg: Boolean(r.bg) })
    else if (r.t === 'sticker' && typeof r.emoji === 'string') out.push({ t: 'sticker', id, emoji: r.emoji.slice(0, 24), x, y, size })
    else if (r.t === 'mention' && typeof r.uid === 'string' && typeof r.username === 'string') out.push({ t: 'mention', id, uid: r.uid, username: r.username.replace(/[^\w.]/g, '').slice(0, 40), x, y, size })
    else if (r.t === 'draw' && Array.isArray(r.pts)) out.push({ t: 'draw', id, color: safeColor(r.color), width: clamp(Number(r.width) || 6, 1, 40), pts: r.pts.slice(0, 2400).map(n => clamp(Math.round(Number(n) || 0), 0, 1000)), glow: Boolean(r.glow) })
  }
  return out
}
const safeColor = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff')
/** Reduce a stroke to at most ~400 points so a scribble never makes the record large. */
export function thinStroke(pts: number[]): number[] {
  const n = pts.length / 2
  if (n <= 400) return pts
  const step = n / 400, out: number[] = []
  for (let i = 0; i < 400; i++) { const k = Math.floor(i * step) * 2; out.push(pts[k], pts[k + 1]) }
  out.push(pts[pts.length - 2], pts[pts.length - 1])
  return out
}

/* ---------------------------------------------------------------- songs */
/** A song chosen for a memory or a reel: from the VYBE library (track_id + preview), or a file from the member's device. */
export interface StudioSong {
  track_id?: string; title: string; artist: string; preview_path?: string | null; artwork_path?: string | null; duration_ms?: number | null
  file?: File; music_path?: string | null; start_ms: number
}
export const CLIP_MS = 15000
/** The longest stretch of a song one item can carry (a long video memory or post plays its song for at most this). */
export const MAX_CLIP_MS = 60000
export const fmtMs = (ms?: number | null) => { if (!ms && ms !== 0) return ''; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** Where to play a song from: a library preview (public), a picked file (local), or a stored file (signed). */
export async function songUrl(s: { preview_path?: string | null; file?: File; music_path?: string | null }, local?: string | null): Promise<string | null> {
  if (s.file) return local ?? null
  if (s.preview_path) return brandUrl(s.preview_path)
  if (s.music_path) return signedUrl(s.music_path)
  return null
}

/**
 * Plays one song from a start point, looping the clip, for as long as `playing` holds. A single element per hook, so
 * leaving the screen always stops the music. Autoplay blocked → `blocked` is true and the screen offers "Tap for sound".
 */
export function useSongPlayer(src: string | null, opts: { start_ms?: number; clip_ms?: number; playing: boolean; muted?: boolean; volume?: number; rate?: number }) {
  // ONE audio element for the life of the hook. Creating a fresh element for every song meant mobile browsers (iOS above all)
  // treated each as "not started by a tap" and refused to play it: the picture advanced and the music stayed silent.
  const el = useRef<HTMLAudioElement | null>(null)
  if (!el.current && typeof Audio !== 'undefined') { const a = new Audio(); a.preload = 'auto'; el.current = a }
  const [blocked, setBlocked] = useState(false)
  const [pos, setPos] = useState(0)
  const start = (opts.start_ms ?? 0) / 1000, clip = (opts.clip_ms ?? CLIP_MS) / 1000
  // The loop reads the current window through a ref: the listeners are attached once, and reading the start from
  // that moment made a later start jump straight back to the first window ("Choose the moment" seemed not to work).
  const win = useRef({ start, clip })
  win.current = { start, clip }
  const want = useRef(opts.playing)
  want.current = opts.playing
  const hasSrc = useRef(false)
  const attempt = useRef(0)
  /** Starts playback; an interrupted load (a newer song replaced this one) is not "blocked", only a refusal is. */
  const tryPlay = () => {
    const a = el.current; if (!a || !hasSrc.current) return
    const n = ++attempt.current
    a.play().then(() => { if (n === attempt.current) setBlocked(false) }, (e: unknown) => {
      if ((e as { name?: string })?.name === 'AbortError') return
      if (n === attempt.current) setBlocked(true)
    })
  }
  useEffect(() => {
    const a = el.current; if (!a) return
    const tick = () => {
      setPos(a.currentTime)
      const { start: s, clip: c } = win.current
      if (a.currentTime >= s + c || a.currentTime < s - 0.5 || (a.duration && a.currentTime >= a.duration - 0.05)) a.currentTime = s
    }
    const ended = () => { a.currentTime = win.current.start; if (want.current && !(a.duration < 0.3)) tryPlay() }   // a degenerate track must not spin
    const ready = () => { if (want.current && a.paused) tryPlay() }
    a.addEventListener('timeupdate', tick); a.addEventListener('ended', ended); a.addEventListener('canplay', ready)
    return () => { a.pause(); a.removeEventListener('timeupdate', tick); a.removeEventListener('ended', ended); a.removeEventListener('canplay', ready); a.removeAttribute('src'); a.load() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = el.current; if (!a) return
    attempt.current++
    if (!src) { hasSrc.current = false; a.pause(); a.removeAttribute('src'); a.load(); setBlocked(false); return }
    hasSrc.current = true
    if (a.getAttribute('src') !== src) { a.src = src; a.load() }
    try { a.currentTime = win.current.start } catch { /* set again once the metadata is in */ }
    if (want.current) tryPlay()
  }, [src]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const a = el.current; if (a && hasSrc.current && Math.abs(a.currentTime - start) > 0.4 && (a.currentTime < start || a.currentTime > start + clip)) a.currentTime = start }, [start]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const a = el.current; if (a) { a.muted = Boolean(opts.muted); a.volume = clamp(opts.volume ?? 1, 0, 1); a.playbackRate = opts.rate ?? 1 } }, [src, opts.muted, opts.volume, opts.rate])
  useEffect(() => {
    const a = el.current; if (!a || !hasSrc.current) return
    if (opts.playing) tryPlay(); else { attempt.current++; a.pause() }
  }, [src, opts.playing]) // eslint-disable-line react-hooks/exhaustive-deps
  const restart = () => { const a = el.current; if (a) { a.currentTime = win.current.start; if (want.current) tryPlay() } }
  /** Call from a tap: starts (or resumes) the song inside the user's gesture, which is what lets browsers allow sound. */
  const unblock = () => { const a = el.current; if (a && hasSrc.current) tryPlay() }
  return { blocked, pos, restart, unblock, audio: el }
}

/* ---------------------------------------------------------------- reel playback settings */
export interface ReelEdit { filter?: FilterKey; speed?: number; trim?: [number, number]; ov?: number; mv?: number; ms?: number }
export const SPEEDS = [0.3, 0.5, 1, 2, 3] as const
export function readReelEdit(raw: unknown): ReelEdit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>, out: ReelEdit = {}
  if (isFilter(r.filter)) out.filter = r.filter
  if (SPEEDS.includes(Number(r.speed) as never)) out.speed = Number(r.speed)
  if (Array.isArray(r.trim) && r.trim.length === 2) { const a = Math.max(0, Number(r.trim[0]) || 0), b = Number(r.trim[1]) || 0; if (b > a + 500) out.trim = [a, b] }
  if (Number.isFinite(Number(r.ov))) out.ov = clamp(Number(r.ov), 0, 1)
  if (Number.isFinite(Number(r.mv))) out.mv = clamp(Number(r.mv), 0, 1)
  if (Number.isFinite(Number(r.ms))) out.ms = Math.max(0, Math.round(Number(r.ms)))
  return out
}

/* ---------------------------------------------------------------- camera preferences (this device) */
export interface CameraPrefs { front: boolean; side: 'left' | 'right'; duration: 15 | 30 | 60 | 90; grid: boolean }
const CAM_KEY = 'vybe:camera'
export function loadCameraPrefs(): CameraPrefs {
  try { const p = JSON.parse(localStorage.getItem(CAM_KEY) ?? '{}'); return { front: Boolean(p.front), side: p.side === 'right' ? 'right' : 'left', duration: [15, 30, 60, 90].includes(p.duration) ? p.duration : 30, grid: Boolean(p.grid) } }
  catch { return { front: false, side: 'left', duration: 30, grid: false } }
}
export function saveCameraPrefs(p: CameraPrefs) { try { localStorage.setItem(CAM_KEY, JSON.stringify(p)) } catch { /* storage unavailable */ } }

/* ---------------------------------------------------------------- close friends */
export async function closeFriendIds(uid: string): Promise<Set<string> | null> {
  const { data, error } = await supabase.from('close_friends').select('friend').eq('owner', uid).limit(500)
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return new Set((data ?? []).map(r => (r as { friend: string }).friend))
}
export async function setCloseFriend(uid: string, friend: string, on: boolean) {
  const { error } = on ? await supabase.from('close_friends').insert({ owner: uid, friend }) : await supabase.from('close_friends').delete().eq('owner', uid).eq('friend', friend)
  if (error && !(on && (error as { code?: string }).code === '23505')) throw error
}

/* ---------------------------------------------------------------- saving a still with its edits */
/** Draws a photo (or a text card) with its filter, text, stickers and drawing into a JPEG, for "Save" to the device. */
export async function renderStill(opts: { img?: HTMLImageElement | null; bg?: string; text?: string; filter: string; overlays: Overlay[]; w?: number; h?: number }): Promise<Blob | null> {
  const W = opts.w ?? 1080, H = opts.h ?? 1920
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d'); if (!g) return null
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H)
  if (opts.img) {
    const i = opts.img, r = Math.min(W / i.naturalWidth, H / i.naturalHeight), w = i.naturalWidth * r, h = i.naturalHeight * r
    g.filter = filterCss(opts.filter) === 'none' ? 'none' : filterCss(opts.filter)
    g.drawImage(i, (W - w) / 2, (H - h) / 2, w, h); g.filter = 'none'
  } else if (opts.bg) {
    const m = opts.bg.match(/#[0-9a-f]{6}/gi) ?? ['#3b2a8f', '#1d1550']
    const gr = g.createLinearGradient(0, 0, W * 0.4, H); gr.addColorStop(0, m[0]); gr.addColorStop(1, m[1] ?? m[0]); g.fillStyle = gr; g.fillRect(0, 0, W, H)
    if (opts.text) { g.fillStyle = '#fff'; g.font = `800 ${W * 0.07}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; wrap(g, opts.text, W / 2, H / 2, W * 0.8, W * 0.085) }
  }
  for (const o of opts.overlays) {
    if (o.t === 'draw') {
      g.strokeStyle = o.color; g.lineWidth = o.width * (W / 400); g.lineCap = 'round'; g.lineJoin = 'round'
      if (o.glow) { g.shadowColor = o.color; g.shadowBlur = 18 } else g.shadowBlur = 0
      g.beginPath()
      for (let k = 0; k < o.pts.length; k += 2) { const x = (o.pts[k] / 1000) * W, y = (o.pts[k + 1] / 1000) * H; if (k) g.lineTo(x, y); else g.moveTo(x, y) }
      g.stroke(); g.shadowBlur = 0
    } else {
      const fs = W * 0.06 * o.size, x = o.x * W, y = o.y * H
      g.textAlign = 'center'; g.textBaseline = 'middle'
      if (o.t === 'sticker') { g.font = `${fs * 1.8}px system-ui, sans-serif`; g.fillText(o.emoji, x, y); continue }
      const label = o.t === 'mention' ? `@${o.username}` : o.text
      g.font = `${o.t === 'text' && o.style === 'serif' ? 'italic 700' : '800'} ${fs}px ${o.t === 'text' && o.style === 'serif' ? 'Georgia, serif' : o.t === 'text' && o.style === 'type' ? 'ui-monospace, monospace' : 'Inter, system-ui, sans-serif'}`
      const tw = g.measureText(label).width
      if (o.t === 'mention' || (o.t === 'text' && o.bg)) { g.fillStyle = o.t === 'mention' ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect?.(x - tw / 2 - fs * 0.4, y - fs * 0.75, tw + fs * 0.8, fs * 1.5, fs * 0.4); g.fill() }
      g.fillStyle = o.t === 'mention' ? '#6a4cff' : o.color
      if (o.t === 'text' && o.style === 'neon') { g.shadowColor = o.color; g.shadowBlur = 20 }
      g.fillText(label, x, y); g.shadowBlur = 0
    }
  }
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.92))
}
function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number) {
  const lines: string[] = []
  for (const para of text.split('\n')) { let cur = ''; for (const w of para.split(' ')) { const t = cur ? `${cur} ${w}` : w; if (g.measureText(t).width > max && cur) { lines.push(cur); cur = w } else cur = t } lines.push(cur) }
  const top = y - ((lines.length - 1) * lh) / 2
  lines.forEach((l, i) => g.fillText(l, x, top + i * lh))
}
export function downloadBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(u), 4000)
}
