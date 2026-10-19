import { useEffect, useState } from 'react'
import { supabase, configured } from './supabase'

/** Authentication-hero configuration (stored in `site_settings`, key `auth_hero`). */
export interface AuthHero {
  media_type?: 'image' | 'video'
  path?: string
  poster_path?: string
  focal_x: number
  focal_y: number
  overlay: number
  headline: string
  body: string
}

export const DEFAULT_HERO: AuthHero = {
  focal_x: 50, focal_y: 50, overlay: 45,
  headline: 'Life is better together.',
  body: 'Discover what moves you. Find your people. Make it happen.',
}

export const HERO_LIMITS = { headline: 120, body: 300, overlayMax: 80, imageBytes: 10 * 1024 * 1024, videoBytes: 50 * 1024 * 1024 }
export const HERO_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const HERO_VIDEO_TYPES = ['video/mp4', 'video/webm']
export const HERO_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' }

const PATH = /^hero\/[0-9a-f-]{36}\.(jpg|png|webp|mp4|webm)$/
const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback)

/** Defensive parse of whatever the server returned: anything malformed degrades to the default rather than breaking sign-in. */
export function normaliseHero(raw: unknown): AuthHero | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const path = typeof r.path === 'string' && PATH.test(r.path) ? r.path : undefined
  const type = r.media_type === 'image' || r.media_type === 'video' ? r.media_type : undefined
  const media = path && type && (type === 'video' ? /\.(mp4|webm)$/ : /\.(jpg|png|webp)$/).test(path)
  const poster = typeof r.poster_path === 'string' && PATH.test(r.poster_path) && type === 'video' ? r.poster_path : undefined
  return {
    media_type: media ? type : undefined,
    path: media ? path : undefined,
    poster_path: media ? poster : undefined,
    focal_x: num(r.focal_x, 0, 100, 50),
    focal_y: num(r.focal_y, 0, 100, 50),
    overlay: num(r.overlay, 0, HERO_LIMITS.overlayMax, 45),
    headline: typeof r.headline === 'string' ? r.headline.slice(0, HERO_LIMITS.headline) : '',
    body: typeof r.body === 'string' ? r.body.slice(0, HERO_LIMITS.body) : '',
  }
}

export const publicBrandUrl = (path: string) => supabase.storage.from('brand').getPublicUrl(path).data.publicUrl

const CACHE = 'vybe:auth-hero'
const readCache = (): AuthHero | null => { try { return normaliseHero(JSON.parse(localStorage.getItem(CACHE) ?? 'null')) } catch { return null } }
const writeCache = (h: AuthHero | null) => { try { h ? localStorage.setItem(CACHE, JSON.stringify(h)) : localStorage.removeItem(CACHE) } catch { /* storage unavailable */ } }

/**
 * The published hero, or null for the built-in default. The last valid copy is kept locally so the page renders
 * instantly and survives a failed request; a successful empty response clears it (the admin unpublished).
 */
export function usePublishedHero() {
  const [hero, setHero] = useState<AuthHero | null>(readCache)
  const [loaded, setLoaded] = useState(!configured)
  useEffect(() => {
    if (!configured) return
    let live = true
    supabase.rpc('get_auth_hero').then(({ data, error }) => {
      if (!live) return
      if (!error) { const h = normaliseHero(data); setHero(h); writeCache(h) }
      setLoaded(true)
    }, () => live && setLoaded(true))
    return () => { live = false }
  }, [])
  return { hero, loaded }
}

/** True from `min` px up; used to avoid loading video on phones. */
export function useMinWidth(min: number) {
  const q = `(min-width: ${min}px)`
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const f = () => setOn(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [q])
  return on
}

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}
export function saveDataOn() {
  return Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData)
}

export type HeroFileCheck = { ok: true; kind: 'image' | 'video' } | { ok: false; error: string }
/** Client-side pre-check; the buckets and publish RPC enforce the same limits server-side. */
export function validateHeroFile(file: { type: string; size: number; name?: string }): HeroFileCheck {
  if (HERO_IMAGE_TYPES.includes(file.type)) {
    return file.size <= HERO_LIMITS.imageBytes ? { ok: true, kind: 'image' } : { ok: false, error: 'Images must be 10 MB or smaller.' }
  }
  if (HERO_VIDEO_TYPES.includes(file.type)) {
    return file.size <= HERO_LIMITS.videoBytes ? { ok: true, kind: 'video' } : { ok: false, error: 'Videos must be 50 MB or smaller.' }
  }
  return { ok: false, error: 'Use a JPG, PNG or WebP image, or an MP4 or WebM video.' }
}

/** Storage path for a new hero asset: unique, flat under `hero/`, extension taken from the validated MIME type. */
export const heroPath = (mime: string) => `hero/${crypto.randomUUID()}.${HERO_EXT[mime] ?? 'bin'}`
