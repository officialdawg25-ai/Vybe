import { describe, expect, it } from 'vitest'
import { buildPlaylist, normaliseSettings, safeLink, DEFAULT_SETTINGS, type PromoSlide, type TrendingEvent } from '../../src/lib/promos'

const ev = (n: number, trending = true): TrendingEvent => ({ id: `e${n}`, title: `Event ${n}`, starts_at: '2030-01-01T00:00:00Z', timezone: 'UTC', city: 'Cape Town', venue: null, cover_path: null, going: 1, price_from_cents: null, trending, score: 10 - n })
const sl = (n: number, extra: Partial<PromoSlide> = {}): PromoSlide => ({ id: `s${n}`, advertiser: '', title: `Slide ${n}`, subtitle: '', cta_label: 'Go', cta_url: '/app/discover', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'chime', city: null, priority: 50, ...extra })
const keys = (l: ReturnType<typeof buildPlaylist>) => l.map(x => x.key)

describe('billboard playlist', () => {
  it('plays trending first and slots a sponsored slide after every (every − 1) trending plans', () => {
    expect(keys(buildPlaylist([ev(1), ev(2), ev(3), ev(4)], [sl(1), sl(2)], { ...DEFAULT_SETTINGS, sponsored_every: 3 }))).toEqual(['t-e1', 't-e2', 's-s1', 't-e3', 't-e4', 's-s2'])
  })
  it('never starts with a sponsored slide when plans are trending, and still shows one when the rule would not place it', () => {
    const l = buildPlaylist([ev(1)], [sl(1)], { ...DEFAULT_SETTINGS, sponsored_every: 6 })
    expect(keys(l)).toEqual(['t-e1', 's-s1'])
  })
  it('falls back to sponsored only, or trending only, or nothing', () => {
    expect(keys(buildPlaylist([], [sl(1), sl(2, { priority: 90 })], DEFAULT_SETTINGS))).toEqual(['s-s2', 's-s1'])
    expect(keys(buildPlaylist([ev(1), ev(2)], [], DEFAULT_SETTINGS))).toEqual(['t-e1', 't-e2'])
    expect(buildPlaylist([], [], DEFAULT_SETTINGS)).toEqual([])
  })
  it('honours the admin switches and the city targeting', () => {
    expect(keys(buildPlaylist([ev(1), ev(2)], [sl(1)], { ...DEFAULT_SETTINGS, trending_enabled: false }))).toEqual(['s-s1'])
    expect(keys(buildPlaylist([ev(1), ev(2), ev(3)], [], { ...DEFAULT_SETTINGS, max_trending: 2 }))).toEqual(['t-e1', 't-e2'])
    const l = buildPlaylist([], [sl(1, { city: 'Durban' }), sl(2, { city: 'cape town' }), sl(3)], DEFAULT_SETTINGS, 'Cape Town')
    expect(keys(l).sort()).toEqual(['s-s2', 's-s3'])
  })
})

describe('billboard safety and settings', () => {
  it('only follows in-app paths and https links', () => {
    expect(safeLink('/app/discover?topic=Music')).toEqual({ href: '/app/discover?topic=Music', external: false })
    expect(safeLink('https://partner.example.com/x')).toEqual({ href: 'https://partner.example.com/x', external: true })
    for (const bad of ['javascript:alert(1)', 'http://insecure.example', '//evil.example', '/etc/passwd', 'data:text/html,x', '/app/<script>']) expect(safeLink(bad)).toBeNull()
  })
  it('clamps and defaults malformed settings', () => {
    expect(normaliseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normaliseSettings({ max_trending: 99, autoplay_ms: 5, sponsored_every: 0, trending_enabled: 'no' })).toEqual({ trending_enabled: true, max_trending: 10, autoplay_ms: 3000, sponsored_every: 2 })
  })
})

describe('promo labels are truthful', () => {
  it('only sponsored slides say Sponsored; house promotions and announcements say they are from VYBE', async () => {
    const { slideLabel, HOUSE, isHouse } = await import('../../src/lib/promos')
    expect(slideLabel({ kind: 'sponsored', advertiser: 'Acme Live' })).toBe('Sponsored · Acme Live')
    expect(slideLabel({ kind: undefined, advertiser: '' })).toBe('Sponsored')                  // slides from before the campaigns migration
    expect(slideLabel({ kind: 'house', advertiser: 'Ignored' })).toBe('From VYBE')
    expect(slideLabel({ kind: 'announcement', advertiser: '' })).toBe('VYBE announcement')
    for (const c of Object.values(HOUSE)) { expect(slideLabel(c)).toBe('From VYBE'); expect(c.cta_url.startsWith('/app/')).toBe(true); expect(isHouse(c)).toBe(true) }
  })
})
