// Shared harness for media browser checks: a MOCKED Supabase (auth, posts, signed storage URLs) that serves REAL media
// files with HTTP range support and an optional delay per file (to imitate a slow or stuck video), plus an in-page
// recorder of every audio/video element's play, playing, pause, waiting, seeked and error events with media times.
import { chromium } from 'playwright'
import { readFileSync, statSync } from 'node:fs'

export const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
export const MEDIA = process.env.MEDIA_DIR
export const ME = 'aaaaaaaa-0000-4000-8000-000000000001', AUTHOR = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
export const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const author = { id: AUTHOR, username: 'thandi', display_name: 'Thandi', avatar_path: null, verified_until: null }

/** Storage paths used by the fixtures → files in MEDIA_DIR. */
export const FILES = {
  [`${AUTHOR}/clip.webm`]: 'portrait.webm', [`${AUTHOR}/wide.webm`]: 'landscape.webm', [`${AUTHOR}/poster.jpg`]: 'poster.jpg', [`${AUTHOR}/song.webm`]: 'song.webm',
  [`${AUTHOR}/hd.webm`]: 'tall-hd.webm', [`${AUTHOR}/hd-480.mp4`]: 'tall-hd-480.mp4',
  [`${AUTHOR}/portrait.jpg`]: 'portrait.jpg', [`${AUTHOR}/landscape.jpg`]: 'landscape.jpg', [`${AUTHOR}/square.jpg`]: 'square.jpg', [`${AUTHOR}/tall.jpg`]: 'tall.jpg',
}
const TYPE = { webm: 'video/webm', jpg: 'image/jpeg', mp4: 'video/mp4', mp3: 'audio/mpeg' }

export function post(id, o = {}) {
  return { id, author: AUTHOR, body: o.body ?? '', media_path: o.media?.[0]?.path ?? null, media_type: o.media?.[0]?.type ?? null, visibility: 'public', community_id: null, event_id: null,
    created_at: o.created_at ?? now, edited_at: null, organization_id: null, org: null, event: null, profiles: author, reactions: [{ count: 3 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: o.saved ? [{ user_id: ME }] : [],
    feeling: null, place_name: null, place_lat: null, place_lng: null, music_track_id: null, music_title: o.song ? 'Test tone' : null, music_artist: o.song ? 'Lab' : null, music_url: null,
    music_path: o.song ? `${AUTHOR}/song.webm` : null, music_start_ms: o.songStart ?? 0, post_media: (o.media ?? []).map((m, sort) => ({ ...m, sort })), tags: [], track: null,
    is_reel: Boolean(o.reel), reel_edit: o.edit ?? null }
}

export const RECORDER = () => {
  const log = (window.__media = [])
  const els = (window.__els = new Set())
  const tag = el => `${el.tagName.toLowerCase()}:${(el.currentSrc || el.src || '').split('/').pop().split('?')[0] || '?'}`
  const seen = new WeakSet()
  const watch = el => {
    if (seen.has(el)) return; seen.add(el); els.add(el)
    for (const ev of ['play', 'playing', 'pause', 'waiting', 'seeked', 'error', 'ended']) el.addEventListener(ev, () => log.push({ t: performance.now(), ev, who: tag(el), ct: el.currentTime }))
  }
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () { watch(this); log.push({ t: performance.now(), ev: 'play()', who: tag(this), ct: this.currentTime }); return play.call(this) }
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n instanceof HTMLMediaElement) watch(n); if (n.querySelectorAll) n.querySelectorAll('video,audio').forEach(watch) }))).observe(document, { childList: true, subtree: true })
}

export async function launch() { return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=user-gesture-required'] }) }

export async function open(browser, url, w = {}) {
  const ctx = await browser.newContext({ viewport: w.viewport ?? { width: 390, height: 844 }, hasTouch: Boolean(w.touch) })
  const seen = { rpc: [], inserts: [], deletes: [], media: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.addInitScript(RECORDER)
  if (w.storage) await ctx.addInitScript(kv => { try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v) } catch {} }, w.storage)
  await ctx.route('https://mock.supabase.test/**', async route => {
    const r = route.request(), u = new URL(r.url()), p = u.pathname
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range, content-length, accept-ranges' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    // storage: sign one or many, then serve the file (with ranges, optional delay or failure per file)
    if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST') {
      const one = decodeURIComponent(p.slice('/storage/v1/object/sign/media/'.length))
      if (one) return FILES[one] || w.files?.[one] ? json({ signedURL: `/object/sign/media/${one}?token=t` }) : json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 400)
      return json((body()?.paths ?? []).map(x => ({ path: x, signedURL: FILES[x] ? `/object/sign/media/${x}?token=t` : null, error: FILES[x] ? null : 'not found' })))
    }
    if (p.startsWith('/storage/v1/object/sign/media/') && r.method() === 'GET') {
      const key = decodeURIComponent(p.slice('/storage/v1/object/sign/media/'.length)), file = FILES[key]
      const rec = { key, range: r.headers().range ?? null, at: Date.now() }; seen.media.push(rec)
      if (!file || w.broken?.includes(key)) return route.fulfill({ status: 404, headers: h, body: 'missing' })
      // w.failOnce: the first request for these files answers 400 like an expired signed link; a re-signed one works
      if (w.failOnce?.includes(key) && !seen.failed?.has(key)) { (seen.failed ??= new Set()).add(key); return route.fulfill({ status: 400, headers: h, body: 'InvalidJWT: exp claim timestamp check failed' }) }
      const delay = w.delay?.[key] ?? 0
      if (delay) await new Promise(res => setTimeout(res, delay))
      const path = `${MEDIA}/${file}`, size = statSync(path).size, buf = readFileSync(path), type = TYPE[file.split('.').pop()]
      const m = /bytes=(\d+)-(\d*)/.exec(r.headers().range ?? '')
      const sent = m ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) - Number(m[1]) + 1 : size
      rec.bytes = sent
      // w.net = { rtt: ms, kbps }: a fixed, reproducible slow link (latency plus transfer time for the bytes sent)
      if (w.net) await new Promise(res => setTimeout(res, w.net.rtt + (sent * 8) / w.net.kbps))
      if (m) { const a = Number(m[1]), b = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; return route.fulfill({ status: 206, headers: { ...h, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': String(b - a + 1) }, body: buf.subarray(a, b + 1) }) }
      return route.fulfill({ status: 200, headers: { ...h, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size) }, body: buf })
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length); seen.rpc.push({ fn, args: body() })
      if (fn === 'my_profile') return json(me)
      if (fn === 'is_admin' || fn === 'is_staff') return json(false)
      if (w.rpc?.[fn]) return json(w.rpc[fn](body()))
      return json(null)
    }
    if (p === '/rest/v1/posts') {
      if (r.method() === 'POST') { seen.inserts.push(body()); return w.insert ? w.insert(body(), json) : json(obj ? { id: 'ffffffff-0000-4000-8000-00000000000f' } : [{ id: 'ffffffff-0000-4000-8000-00000000000f' }], 201) }
      const ids = /in\.\(([^)]*)\)/.exec(u.searchParams.get('id') ?? '')?.[1]?.split(',') ?? (u.searchParams.get('id')?.startsWith('eq.') ? [u.searchParams.get('id').slice(3)] : null)
      let rows = w.posts ?? []
      if (ids) rows = rows.filter(x => ids.includes(x.id))
      if (u.searchParams.get('is_reel') === 'eq.true') rows = rows.filter(x => x.is_reel)
      return json(obj ? rows[0] ?? null : rows)
    }
    if (p === '/rest/v1/saves' || p === '/rest/v1/reactions') { if (r.method() === 'POST') seen.inserts.push({ table: p, ...body() }); if (r.method() === 'DELETE') seen.deletes.push({ table: p, q: u.search }); return json([], 201) }
    if (p === '/rest/v1/profiles') return json(obj ? me : [me])
    return json(obj ? null : [])
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors, media: () => page.evaluate(() => window.__media) }
}
