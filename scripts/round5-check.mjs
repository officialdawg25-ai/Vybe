// Browser checks for the production-evolution round against a MOCKED API (and, for the camera test, the local LiveKit dev
// server from scripts/live-e2e.mjs if LK_URL is reachable): data modes, feed video lifecycle, the feed's compound cursor,
// Reels keeping what is on screen when a next page fails, billboard filtering for admins, the first feed page starting
// with the app, and the live screen's quality choice and camera-permission message.
import { chromium } from 'playwright'
import { createHmac } from 'node:crypto'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const LK_URL = process.env.LK_URL ?? 'ws://127.0.0.1:7880'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null, onboarded_at: now, interests: [] }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const uid = n => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`
const T = '2026-10-25T09:00:00.123456+00:00'                         // every post shares this time: only the id orders them
const post = (n, video = false, reel = false) => ({ id: uid(n), author: OTHER, body: `Post ${n}`, media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, is_reel: reel, created_at: T, edited_at: null, profiles: other, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], tags: [], post_media: video ? [{ path: `${OTHER}/v${n}.webm`, type: 'video', sort: 0, poster_path: `${OTHER}/v${n}.png` }] : [] })
const jwt = claims => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(claims); return `${h}.${p}.${createHmac('sha256', 'secret').update(`${h}.${p}`).digest('base64url')}` }

// Without camera permission Chromium hides local addresses behind mDNS names, which a loopback test server cannot use; a real
// deployment (public LiveKit address) is unaffected. Turned off here only so the permission test can reach the local server.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ url = '/app', width = 390, height = 844, mode, admin = false, page1 = [], page2 = [], reels = [], failNext = false, slides = [], perms } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...(perms ? { permissions: perms } : {}) })
  const seen = { posts: [], promo: [], firstPostsAt: null, profileAt: null }
  await ctx.addInitScript(([s, m]) => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s); if (m) localStorage.setItem('vybe:data-mode', m) } catch {} }, [JSON.stringify(session), mode ?? null])
  await ctx.route('https://mock.supabase.test/**', async route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname === '/storage/v1/object/sign/media' && r.method() === 'POST') return json(JSON.parse(r.postData() ?? '{}').paths.map(p => ({ path: p, signedURL: `/object/sign/media/${p}?token=t`, error: null })))
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: `${u.pathname.replace('/storage/v1', '')}?token=t` })
    if (u.pathname.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
    if (u.pathname === '/functions/v1/livekit-token') { const b = JSON.parse(r.postData() ?? '{}'); return json({ token: jwt({ iss: 'devkey', sub: ME, nbf: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 600, video: { room: `r5-${Date.now()}`, roomJoin: true, canPublish: Boolean(b.publish), canSubscribe: true, canPublishData: true } }), url: LK_URL, room: 'x', role: 'host', name: 'Alice', title: 'Test' }) }
    if (u.pathname === '/rest/v1/rpc/my_profile') { seen.profileAt ??= Date.now(); await new Promise(res => setTimeout(res, 400)); return json(me) }
    if (u.pathname === '/rest/v1/rpc/is_admin' || u.pathname === '/rest/v1/rpc/is_staff') return json(admin)
    if (u.pathname === '/rest/v1/profiles') return json(one ? me : [me])
    if (u.pathname === '/rest/v1/live_streams') { const s = { id: 's1', host: ME, title: 'Test', status: 'scheduled', access: 'open', event_id: null, profiles: me }; return json(one ? s : [s]) }
    if (u.pathname === '/rest/v1/promo_slides') { seen.promo.push(u.search); return json(slides) }
    if (u.pathname === '/rest/v1/posts') {
      seen.posts.push(u.search); seen.firstPostsAt ??= Date.now()
      if (u.searchParams.get('is_reel')) return u.searchParams.has('or') ? (failNext ? json({ message: 'boom' }, 500) : json([])) : json(reels)
      if (u.searchParams.has('id')) return json([])
      return json(u.searchParams.has('or') ? page2 : page1)
    }
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(e.message))
  const t0 = Date.now()
  await page.goto(BASE + url); await page.waitForTimeout(1500)
  return { page, ctx, seen, errs, t0 }
}

/* Feed: first page requested with the app, before the profile check answers; compound cursor for page 2. */
let t = await open({ page1: Array.from({ length: 15 }, (_, i) => post(100 - i)), page2: [post(50)] })
check('opening on Home asks for the first feed page while the profile check is still answering', t.seen.firstPostsAt != null && t.seen.profileAt != null && t.seen.firstPostsAt < t.seen.profileAt + 400, `posts at +${t.seen.firstPostsAt - t.t0} ms, profile answered at +${t.seen.profileAt + 400 - t.t0} ms`)
check('the first page is requested once (the early request is reused, not repeated)', t.seen.posts.filter(q => !q.includes('or=') && !/[?&]id=/.test(q)).length === 1, t.seen.posts.map(q => q.slice(0, 40)).join(' | '))
await t.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await t.page.waitForTimeout(1200)
const next = t.seen.posts.find(q => q.includes('or='))
const dec = next ? decodeURIComponent(next) : ''
check('page 2 continues after the last post by time AND id (posts sharing a timestamp are not skipped)', dec.includes(`or=(created_at.lt."${T}",and(created_at.eq."${T}",id.lt.${uid(86)}))`) && dec.includes('order=created_at.desc,id.desc'), dec.slice(dec.indexOf('or='), dec.indexOf('or=') + 140))
check('page 2 is shown below page 1', await t.page.getByText('Post 50', { exact: true }).count() === 1)
check('no page errors (feed)', !t.errs.length, t.errs.join(' | '))
await t.ctx.close()

/* Feed videos: auto plays muted on screen; data saver waits for a tap and loads nothing first. */
t = await open({ page1: [post(1, true), post(2), post(3), post(4), post(5), post(6, true)] })
check('Automatic: an on-screen feed video has a player', await t.page.locator('.igp-slide video').count() >= 1)
await t.ctx.close()
t = await open({ mode: 'saver', page1: [post(1, true), post(2)] })
check('Data saver: the feed shows the poster with a Play button and no video player until tapped', await t.page.getByRole('button', { name: 'Play video' }).count() === 1 && await t.page.locator('.igp-slide video').count() === 0)
await t.page.getByRole('button', { name: 'Play video' }).click(); await t.page.waitForTimeout(300)
check('…and a tap starts it', await t.page.locator('.igp-slide video').count() === 1)
await t.ctx.close()
t = await open({ page1: [post(1, true), ...Array.from({ length: 12 }, (_, i) => ({ ...post(10 + i), body: 'A long post to read. '.repeat(60) }))] })
await t.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await t.page.waitForTimeout(800)
check('a video scrolled far away gives up its player for a same-size poster', await t.page.locator('.igp-slide video').count() === 0 && await t.page.locator('.igp-poster').count() === 1, JSON.stringify(await t.page.evaluate(() => ({ h: document.body.scrollHeight, y: scrollY, vids: document.querySelectorAll('.igp-slide video').length, posters: document.querySelectorAll('.igp-poster').length, slideTop: document.querySelector('.igp-slide')?.getBoundingClientRect().top }))))
await t.ctx.close()

/* Settings: the data choice is per device and remembered. */
t = await open({ url: '/app/settings' })
await t.page.getByRole('radio', { name: /Data saver/ }).check(); await t.page.waitForTimeout(200)
check('Settings → Data & video remembers the choice on this device', await t.page.evaluate(() => localStorage.getItem('vybe:data-mode')) === 'saver')
await t.ctx.close()

/* Reels: a failed next page keeps the reel on screen. */
t = await open({ url: '/app/reels', reels: [post(1, true, true), post(2, true, true)], failNext: true })
await t.page.evaluate(() => { const l = document.querySelector('.reels-list'); l?.scrollTo({ top: l.clientHeight }) }); await t.page.waitForTimeout(1200)
check('Reels: when the next page fails, the reels stay and a short message explains', await t.page.locator('.reel').count() === 2 && await t.page.getByText('Couldn’t load more reels').count() === 1)
await t.ctx.close()

/* Billboard: only live slides inside their dates are requested, also for admins (whose read rule includes drafts). */
const past = new Date(Date.now() - 1000).toISOString()
t = await open({ admin: true, slides: [{ id: uid(900), advertiser: 'Acme', title: 'Ended a moment ago', subtitle: '', cta_label: 'Go', cta_url: '/app/discover', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'none', city: null, priority: 90, ends_at: past, kind: 'sponsored', placements: ['home'] }] })
const pq = decodeURIComponent(t.seen.promo[0] ?? '')
check('billboard asks only for live slides within their dates', pq.includes('status=eq.live') && /starts_at=lte\./.test(pq) && /or=\(ends_at\.is\.null,ends_at\.gt\."/.test(pq), pq.slice(0, 200))
check('a slide whose end time has passed is not shown even if returned', await t.page.getByText('Ended a moment ago').count() === 0)
await t.ctx.close()

/* Live: quality choice before going live; a denied camera explains what to do. */
t = await open({ url: '/app/live/s1/host', width: 1280, height: 800 })
check('host chooses the video quality before going live (Auto plus 1080p/720p/480p/360p)', await t.page.getByRole('radiogroup', { name: 'Video quality' }).isVisible() && await t.page.getByRole('radio', { name: '1080p', exact: true }).count() === 1 && await t.page.getByRole('radio', { name: /^Auto \(/ }).getAttribute('aria-checked') === 'true')
await t.page.getByRole('button', { name: 'Go live' }).click()
await t.page.getByRole('alert').waitFor({ timeout: 15000 }).catch(() => {})
const alert = await t.page.getByRole('alert').textContent().catch(() => '')
check('without camera permission the host is told how to allow it (not a blank screen)', /Allow them in your browser’s site settings|No camera or microphone was found|camera could not start/.test(alert ?? ''), alert ?? 'no alert (is the local LiveKit server running?)')
await t.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall round 5 checks passed')
process.exit(failures ? 1 : 0)
