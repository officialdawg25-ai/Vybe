import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import { useAsync } from './hooks'
import type { Place } from './location'

/** What the Home billboard may show. Sponsored slides are admin-managed rows; trending slides are computed by the database. */
export interface PromoSlide {
  id: string; advertiser: string; title: string; subtitle: string; cta_label: string; cta_url: string
  media_type: 'image' | 'video' | null; media_path: string | null; poster_path: string | null
  focal_x: number; focal_y: number; accent: string; sound: 'none' | 'chime'; city: string | null; priority: number
}
export interface TrendingEvent {
  id: string; title: string; starts_at: string; timezone: string; city: string | null; venue: string | null
  cover_path: string | null; going: number; price_from_cents: number | null; trending: boolean; score: number
}
export interface HeroSettings { trending_enabled: boolean; max_trending: number; autoplay_ms: number; sponsored_every: number }
export const DEFAULT_SETTINGS: HeroSettings = { trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 }

export type BillboardItem =
  | { kind: 'sponsored'; key: string; slide: PromoSlide }
  | { kind: 'trending'; key: string; event: TrendingEvent }

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
export const normaliseSettings = (raw: unknown): HeroSettings => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    trending_enabled: typeof r.trending_enabled === 'boolean' ? r.trending_enabled : true,
    max_trending: num(r.max_trending, 0, 10, 5), autoplay_ms: num(r.autoplay_ms, 3000, 20000, 7000), sponsored_every: num(r.sponsored_every, 2, 6, 3),
  }
}

/** Only same-app paths and https links are ever followed; anything else is dropped. */
export const safeLink = (url: string): { href: string; external: boolean } | null =>
  /^\/app\/[A-Za-z0-9/_?=&.%-]*$/.test(url) ? { href: url, external: false } : /^https:\/\/\S+$/.test(url) ? { href: url, external: true } : null

/**
 * Trending first (that is what the billboard is for), with a sponsored slide after every (sponsored_every − 1) trending ones.
 * Slides ranked by priority. If there are sponsored slides but the rule never placed one, one closes the loop.
 */
export function buildPlaylist(trending: TrendingEvent[], slides: PromoSlide[], s: HeroSettings, city?: string): BillboardItem[] {
  const spons = slides.filter(x => !x.city || !city || x.city.toLowerCase() === city.toLowerCase()).sort((a, b) => b.priority - a.priority)
  const trend = (s.trending_enabled ? trending : []).slice(0, s.max_trending)
  if (!trend.length) return spons.map(slide => ({ kind: 'sponsored', key: `s-${slide.id}`, slide }))
  const out: BillboardItem[] = []
  let si = 0
  trend.forEach((event, i) => {
    out.push({ kind: 'trending', key: `t-${event.id}`, event })
    if ((i + 1) % Math.max(1, s.sponsored_every - 1) === 0 && si < spons.length) { out.push({ kind: 'sponsored', key: `s-${spons[si].id}`, slide: spons[si] }); si++ }
  })
  if (si === 0 && spons.length) out.push({ kind: 'sponsored', key: `s-${spons[0].id}`, slide: spons[0] })
  return out
}

const COLS = 'id,advertiser,title,subtitle,cta_label,cta_url,media_type,media_path,poster_path,focal_x,focal_y,accent,sound,city,priority'
export const promoUrl = (path: string) => supabase.storage.from('brand').getPublicUrl(path).data.publicUrl

/** Loads everything the billboard needs. Each source fails soft: a missing migration or network blip hides that source, never Home. */
export function useBillboard(place: Place) {
  const r = useAsync(async () => {
    const [cfg, slides, trend] = await Promise.all([
      supabase.rpc('home_hero_settings'),
      supabase.from('promo_slides').select(COLS).order('priority', { ascending: false }).limit(20),
      supabase.rpc('trending_events', { p_lat: place.lat, p_lng: place.lng, p_radius_km: 60, p_limit: 10 }),
    ])
    for (const x of [cfg, slides, trend]) if (x.error && !isMissingSchema(x.error)) console.warn('billboard source unavailable', x.error.message)
    const settings = normaliseSettings(cfg.data)
    const now = Date.now()
    return {
      settings,
      slides: ((slides.data ?? []) as PromoSlide[]).filter(s => !!safeLink(s.cta_url)),
      trending: (Array.isArray(trend.data) ? trend.data : []) as TrendingEvent[],
      at: now,
    }
  }, [place.lat, place.lng])
  const items = useMemo(() => (r.data ? buildPlaylist(r.data.trending, r.data.slides, r.data.settings, place.name.split(',')[0].replace(/^Near /, '')) : []), [r.data, place.name])
  return { items, settings: r.data?.settings ?? DEFAULT_SETTINGS, loading: r.loading && !r.data }
}

/** Counts a view once per slide per page session; the database dedupes per member per day on top. */
const counted = new Set<string>()
export function track(slideId: string, kind: 'impression' | 'click') {
  const k = `${kind}:${slideId}`
  if (kind === 'impression' && counted.has(k)) return
  counted.add(k)
  void supabase.rpc('promo_track', { p_slide: slideId, p_kind: kind }).then(() => {}, () => {})
}

export const BILLBOARD_SOUND_KEY = 'vybe:billboard-sound'
export function useBillboardSound() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(BILLBOARD_SOUND_KEY) !== '0' } catch { return true } })
  const set = (v: boolean) => { setOn(v); try { localStorage.setItem(BILLBOARD_SOUND_KEY, v ? '1' : '0') } catch { /* storage unavailable */ } }
  return [on, set] as const
}

export function useReducedMotion() {
  const [r, setR] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia('(prefers-reduced-motion: reduce)'), f = () => setR(m.matches)
    m.addEventListener('change', f); return () => m.removeEventListener('change', f)
  }, [])
  return r
}
export const useLatest = <T,>(v: T) => { const r = useRef(v); r.current = v; return r }
