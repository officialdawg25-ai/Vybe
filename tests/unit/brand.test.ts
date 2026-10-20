import { describe, expect, it } from 'vitest'
import { splashMode } from '../../src/brand/splash'
import { DEFAULT_HERO, normaliseHero, validateHeroFile } from '../../src/lib/hero'
import { friendsAndMe, homeReason, rankByInterest, sharedInterests } from '../../src/lib/feeds'
import { WORDMARK } from '../../src/brand/logoPaths'

const base = { path: '/', seenEver: false, seenThisSession: false, signedInHint: false, reducedMotion: false }

describe('splash decision', () => {
  it('plays the full sequence on a first visit to the entry route', () => expect(splashMode(base)).toBe('full'))
  it('plays a short version for a returning visitor in a new session', () => expect(splashMode({ ...base, seenEver: true })).toBe('short'))
  it('never replays within a session', () => expect(splashMode({ ...base, seenEver: true, seenThisSession: true })).toBe('none'))
  it('skips returning signed-in users', () => expect(splashMode({ ...base, seenEver: true, signedInHint: true })).toBe('none'))
  it('never delays deep links, auth routes or the app', () => {
    for (const path of ['/signin', '/signup', '/reset', '/app', '/app/plans/1', '/privacy']) expect(splashMode({ ...base, path })).toBe('none')
  })
  it('uses the static wordmark when reduced motion is requested', () => {
    expect(splashMode({ ...base, reducedMotion: true })).toBe('reduced')
    expect(splashMode({ ...base, reducedMotion: true, seenEver: true })).toBe('reduced')
  })
})

describe('wordmark geometry', () => {
  it('has the four letters V, Y, B, E in order, left to right', () => {
    expect(WORDMARK.letters.map(l => l.id).join('')).toBe('VYBE')
    const xs = WORDMARK.letters.map(l => l.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
  })
  it('letters do not overlap and fit the overall width', () => {
    const L = WORDMARK.letters
    for (let i = 1; i < L.length; i++) expect(L[i].x).toBeGreaterThan(L[i - 1].x + L[i - 1].w)
    expect(L[3].x + L[3].w).toBeLessThanOrEqual(WORDMARK.width + 0.5)
  })
  it('every letter is a closed path', () => { for (const l of WORDMARK.letters) expect(l.d.trim().endsWith('Z')).toBe(true) })
})

describe('authentication hero configuration', () => {
  const U = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
  it('accepts a valid image config and clamps numbers', () => {
    const h = normaliseHero({ media_type: 'image', path: `hero/${U}.jpg`, focal_x: 140, focal_y: -5, overlay: 99, headline: 'Hi', body: 'There' })
    expect(h).toMatchObject({ media_type: 'image', path: `hero/${U}.jpg`, focal_x: 100, focal_y: 0, overlay: 80 })
  })
  it('drops media with a malformed or mismatched path', () => {
    expect(normaliseHero({ media_type: 'image', path: '../../etc/passwd' })?.path).toBeUndefined()
    expect(normaliseHero({ media_type: 'image', path: `hero/${U}.mp4` })?.path).toBeUndefined()
    expect(normaliseHero({ media_type: 'video', path: `hero/${U}.jpg` })?.path).toBeUndefined()
    expect(normaliseHero({ media_type: 'image', path: 'https://evil.example/x.jpg' })?.path).toBeUndefined()
  })
  it('only keeps a poster for videos', () => {
    expect(normaliseHero({ media_type: 'video', path: `hero/${U}.mp4`, poster_path: `hero/${U}.jpg` })?.poster_path).toBe(`hero/${U}.jpg`)
    expect(normaliseHero({ media_type: 'image', path: `hero/${U}.jpg`, poster_path: `hero/${U}.jpg` })?.poster_path).toBeUndefined()
  })
  it('treats non-objects as "use the default"', () => { for (const v of [null, undefined, 'x', 5]) expect(normaliseHero(v)).toBeNull() })
  it('falls back to safe values for missing fields', () => expect(normaliseHero({})).toMatchObject({ focal_x: 50, focal_y: 50, overlay: 45, headline: '', body: '' }))
  it('ships the approved default copy', () => expect(DEFAULT_HERO.headline).toBe('Life is better together.'))
  it('validates uploads by type and size', () => {
    expect(validateHeroFile({ type: 'image/jpeg', size: 1000 })).toEqual({ ok: true, kind: 'image' })
    expect(validateHeroFile({ type: 'video/mp4', size: 49 * 1024 * 1024 })).toEqual({ ok: true, kind: 'video' })
    expect(validateHeroFile({ type: 'video/mp4', size: 51 * 1024 * 1024 }).ok).toBe(false)
    expect(validateHeroFile({ type: 'image/png', size: 11 * 1024 * 1024 }).ok).toBe(false)
    for (const type of ['image/gif', 'image/svg+xml', 'text/html', 'application/x-msdownload', 'video/quicktime']) expect(validateHeroFile({ type, size: 10 }).ok).toBe(false)
  })
})

describe('Home and Discover selection rules', () => {
  const me = 'u-me', f1 = 'u-f1'
  it('Friends tab = yourself + friends (deduplicated, capped)', () => {
    expect(friendsAndMe(me, [f1, me])).toEqual([me, f1])
    expect(friendsAndMe(me, Array.from({ length: 500 }, (_, i) => `f${i}`))).toHaveLength(200)
  })
  it('explains why a post is on Home', () => {
    const friends = new Set([f1])
    expect(homeReason({ author: me, visibility: 'public', community_id: null }, me, friends)).toBe('Your post')
    expect(homeReason({ author: f1, visibility: 'friends', community_id: null }, me, friends)).toBe('From a friend')
    expect(homeReason({ author: 'x', visibility: 'public', community_id: null, organization_id: 'o' }, me, friends)).toBe('From a page')
    expect(homeReason({ author: 'x', visibility: 'community', community_id: 'c1' }, me, friends)).toBe('From a community you belong to')
    expect(homeReason({ author: 'x', visibility: 'public', community_id: null }, me, friends)).toBe('Public post')
  })
  it('ranks by shared interests and keeps the incoming order within a tier', () => {
    const items = [{ n: 'a', i: ['Art'] }, { n: 'b', i: ['Music', 'Food'] }, { n: 'c', i: ['music'] }, { n: 'd', i: [] }]
    expect(rankByInterest(items, ['Music', 'Food'], x => x.i).map(x => x.n)).toEqual(['b', 'c', 'a', 'd'])
    expect(sharedInterests(['Music'], ['music', 'Art'])).toEqual(['music'])
  })
})
