import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import { useAsync } from './hooks'
import type { Place } from './location'

/** What the Home billboard may show. Sponsored slides are admin-managed rows; trending slides are computed by the database. */
export type Placement = 'home' | 'discover'
/** sponsored = paid placement (always labelled); house = VYBE's own promotion; announcement = platform news. */
export type SlideKind = 'sponsored' | 'house' | 'announcement'
export interface PromoSlide {
  id: string; advertiser: string; title: string; subtitle: string; cta_label: string; cta_url: string
  media_type: 'image' | 'video' | null; media_path: string | null; poster_path: string | null
  focal_x: number; focal_y: number; accent: string; sound: 'none' | 'chime'; city: string | null; priority: number
  kind?: SlideKind; placements?: Placement[]
}

/** The disclosure line every slide carries, so paid placements are never mistaken for VYBE's own content (and vice versa). */
export const slideLabel = (s: Pick<PromoSlide, 'kind' | 'advertiser'>) =>
  s.kind === 'house' ? 'From VYBE' : s.kind === 'announcement' ? 'VYBE announcement' : `Sponsored${s.advertiser ? ` · ${s.advertiser}` : ''}`

/**
 * Shown when a placement has nothing live: VYBE's own, truthful promotions (no invented advertisers or partners).
 * They are never tracked as impressions.
 */
export const HOUSE: Record<Placement, PromoSlide> = {
  home: { id: 'house-home', kind: 'house', advertiser: '', title: 'Life is better together', subtitle: 'Host a plan and let your people find it.', cta_label: 'Host a plan', cta_url: '/app/plans?new=1', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'none', city: null, priority: 0 },
  discover: { id: 'house-discover', kind: 'house', advertiser: '', title: 'Discover what moves you', subtitle: 'Concerts, events, artists and communities near you.', cta_label: 'Explore events', cta_url: '/app/discover?mode=events', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#e0457b', sound: 'none', city: null, priority: 0 },
}
export const isHouse = (s: PromoSlide) => s.id.startsWith('house-')
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

const BASE_COLS = 'id,advertiser,title,subtitle,cta_label,cta_url,media_type,media_path,poster_path,focal_x,focal_y,accent,sound,city,priority'

/** Live slides for one placement. Before the campaigns migration (no placements column) only Home has slides. */
async function liveSlides(placement: Placement) {
  const r = await supabase.from('promo_slides').select(`${BASE_COLS},kind,placements`).contains('placements', [placement]).order('priority', { ascending: false }).limit(20)
  if (!r.error || !isMissingSchema(r.error)) return r
  return placement === 'home' ? supabase.from('promo_slides').select(BASE_COLS).order('priority', { ascending: false }).limit(20) : { data: [], error: null }
}
export const promoUrl = (path: string) => supabase.storage.from('brand').getPublicUrl(path).data.publicUrl

/**
 * Loads everything a placement needs. Each source fails soft: a missing migration or network blip hides that source, never
 * the page. Home mixes trending plans with slides; Discover shows only slides placed there.
 */
// A request started early (prefetchBillboard) is handed to the first useBillboard that asks for the same thing, once.
const early = new Map<string, Promise<BillboardSources>>()
type BillboardSources = [Awaited<ReturnType<typeof hero>>, Awaited<ReturnType<typeof liveSlides>>, { data: unknown; error: { code?: string; message: string } | null }]
const hero = () => supabase.rpc('home_hero_settings')
const sourceKey = (place: Place, placement: Placement) => `${placement}|${placement === 'home' ? `${place.lat},${place.lng}` : ''}`
const loadSources = (place: Place, placement: Placement) => Promise.all([
  hero(),
  liveSlides(placement),
  placement === 'home' ? supabase.rpc('trending_events', { p_lat: place.lat, p_lng: place.lng, p_radius_km: 60, p_limit: 10 }) : Promise.resolve({ data: [], error: null }),
]) as Promise<BillboardSources>
/**
 * Starts the billboard's data requests now, so they run while the billboard's code is still downloading instead of after
 * it (the page calls this as soon as it renders). Used once, then forgotten; a later visit asks again.
 */
export function prefetchBillboard(place: Place, placement: Placement) {
  const k = sourceKey(place, placement)
  if (!early.has(k)) early.set(k, loadSources(place, placement))
}

export function useBillboard(place: Place, placement: Placement = 'home') {
  const r = useAsync(async () => {
    const k = sourceKey(place, placement), pre = early.get(k)
    early.delete(k)
    const [cfg, slides, trend] = await (pre ?? loadSources(place, placement))
    for (const x of [cfg, slides, trend]) if (x.error && !isMissingSchema(x.error)) console.warn('billboard source unavailable', x.error.message)
    const settings = normaliseSettings(cfg.data)
    const now = Date.now()
    return {
      settings,
      slides: ((slides.data ?? []) as PromoSlide[]).filter(s => !!safeLink(s.cta_url)),
      trending: (Array.isArray(trend.data) ? trend.data : []) as TrendingEvent[],
      at: now,
    }
  }, [place.lat, place.lng, placement])
  const items = useMemo(() => {
    if (!r.data) return []
    const list = buildPlaylist(r.data.trending, r.data.slides, r.data.settings, place.name.split(',')[0].replace(/^Near /, ''))
    return list.length ? list : [{ kind: 'sponsored', key: `h-${placement}`, slide: HOUSE[placement] } as BillboardItem]
  }, [r.data, place.name, placement])
  return { items, settings: r.data?.settings ?? DEFAULT_SETTINGS, loading: r.loading && !r.data }
}

/** Counts a view once per slide per page session; the database dedupes per member per day on top. */
const counted = new Set<string>()
export function track(slideId: string, kind: 'impression' | 'click') {
  if (slideId.startsWith('house-')) return
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

/** True while at least half of the element is on screen: an impression is only counted for a slide someone could see. */
export function useInView<T extends Element>(ref: RefObject<T | null>) {
  const [v, setV] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setV(true); return }
    const io = new IntersectionObserver(([e]) => setV(e.isIntersecting && e.intersectionRatio >= 0.5), { threshold: [0, 0.5, 1] })
    io.observe(el); return () => io.disconnect()
  }, [ref])
  return v
}

/**
 * Checks a creative's first bytes against its declared type (JPEG, PNG, WebP, MP4, WebM), so a renamed file of another
 * kind is refused before upload. The storage bucket also restricts types and size on the server.
 */
export async function sniffCreative(file: File): Promise<'image' | 'video' | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const at = (o: number, ...xs: number[]) => xs.every((x, i) => b[o + i] === x)
  const ascii = (o: number, t: string) => [...t].every((c, i) => b[o + i] === c.charCodeAt(0))
  if (file.type === 'image/jpeg' && at(0, 0xff, 0xd8, 0xff)) return 'image'
  if (file.type === 'image/png' && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image'
  if (file.type === 'image/webp' && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image'
  if (file.type === 'video/mp4' && ascii(4, 'ftyp')) return 'video'
  if (file.type === 'video/webm' && at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video'
  return null
}
