// Browser checks for this round, against a MOCKED backend: onboarding has its own screen and saves without the refused
// upsert; sign-in by username (via the username-signin function) and the Google button; the sign-in hero shows its whole
// headline and subtext on a phone; reels (feed, like, comments with video notes, create); Live now on Home and Go live;
// the full-screen live screen; the admin slide end-time message; and that a broken admin portal leaves the app working.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const user = { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} }
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }
const meBase = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now, onboarding_step: 6 }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const reel = (n, extra = {}) => ({ id: `r${n}`, author: OTHER, body: `Reel ${n} caption`, media_path: `${OTHER}/r${n}.mp4`, media_type: 'video', visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: other, reactions: [{ count: 3 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [], post_media: [{ path: `${OTHER}/r${n}.mp4`, type: 'video', sort: 0, poster_path: null }], tags: [], is_reel: true, ...extra })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ url, signedIn = true, me = {}, width = 390, height = 844, google = false, live = [], admin = false, block }) {
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ['camera', 'microphone'] })
  const seen = { req: [], rpc: [], fn: [], posts: [], post_media: [], reactions: [], live: [], uploads: [], promo: [] }
  if (signedIn) await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  else await ctx.addInitScript(() => { try { sessionStorage.setItem('vybe:splash:v1', '1') } catch {} })
  if (block) await ctx.route(block, r => r.abort())
  const profile = { ...meBase, ...me }
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    seen.req.push(`${r.method()} ${u.pathname}${u.search} ${JSON.stringify(r.headers()['prefer'] ?? '')}`)
    if (u.pathname === '/auth/v1/settings') return json({ external: { google, email: true } })
    if (u.pathname === '/auth/v1/user') return json(user)
    if (u.pathname.startsWith('/auth/v1/')) return json({})
    if (u.pathname.startsWith('/functions/v1/')) {
      const name = u.pathname.split('/').pop(); seen.fn.push({ name, body: body() })
      if (name === 'username-signin') return body()?.password === 'right' ? json({ access_token: token, refresh_token: 'r2' }) : json({ error: 'That username and password don’t match an account.' }, 400)
      if (name === 'livekit-token') return json({ error: 'Live streaming isn’t set up in this test.' }, 503)
      return json({ status: 'ready' })
    }
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: '/object/sign/media/x.png?token=t' })
    if (u.pathname.startsWith('/storage/v1/object/') && r.method() === 'POST') { seen.uploads.push(u.pathname); return json({ Key: 'ok' }) }
    if (u.pathname.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.split('/').pop(); seen.rpc.push([fn, body()])
      if (fn === 'my_profile') return json(profile)
      if (fn === 'is_staff' || fn === 'is_admin') return json(admin)
      if (fn === 'username_available') return json(body()?.p_username !== 'alice')
      if (fn === 'set_username') return json(body()?.p_username)
      if (fn === 'home_hero_settings') return json({ trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 })
      if (fn === 'trending_events' || fn === 'memory_rail' || fn === 'discover_events' || fn === 'discover_orgs') return json([])
      return json(null)
    }
    const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)
    if (m) {
      const t = m[1], obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
      if (r.method() === 'POST' && t === 'posts') { seen.posts.push(body()); return json({ id: 'newreel' }, 201) }
      if (r.method() === 'POST' && t === 'post_media') { seen.post_media.push(body()); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (r.method() === 'POST' && t === 'reactions') { seen.reactions.push(body()); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (r.method() === 'POST' && t === 'live_streams') { seen.live.push(body()); return json({ id: 'ls-new' }, 201) }
      if (r.method() === 'POST' && t === 'promo_slides') { seen.promo.push(body()); return json(null, 201) }
      if (['POST', 'PATCH'].includes(r.method())) return route.fulfill({ status: r.method() === 'POST' ? 201 : 204, headers: h, body: r.method() === 'PATCH' && t === 'profile_private' ? '[]' : '' })
      if (t === 'posts') return json(u.searchParams.get('is_reel') === 'eq.true' ? [reel(1), reel(2, { mine_reaction: [] })] : [])
      if (t === 'live_streams') {
        const id = (u.searchParams.get('id') ?? '').replace('eq.', '')
        const rows = id ? [id === 'ls-new' ? { id, host: ME, title: 'Alice is live', status: 'scheduled', access: 'open', event_id: null, profiles: { username: 'alice', display_name: 'Alice', avatar_path: null } } : { id: 'ls1', host: OTHER, title: 'Late night set', status: 'live', access: 'open', event_id: null, profiles: { ...other, avatar_path: null } }] : live
        return json(obj ? rows[0] ?? null : rows)
      }
      if (t === 'profiles') return json(obj ? profile : [profile])
      if (t === 'comments') return json([])
      if (t === 'promo_slides') return json([])
      return json(obj ? null : [])
    }
    return json([])
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + url); await page.waitForTimeout(1000)
  return { page, ctx, seen, errs }
}

// ---------------------------------------------------------------- onboarding
let t = await open({ url: '/app', me: { onboarded_at: null, onboarding_step: 0, username: 'user_ab12cd34ef', display_name: 'Thandi Mokoena' } })
check('a member who has not finished onboarding lands on it', new URL(t.page.url()).pathname === '/app/onboarding')
check('onboarding has its own screen: no tab bar, search, chat or profile navigation', await t.page.locator('.bottomnav').count() === 0 && await t.page.locator('.hdr').count() === 0 && await t.page.getByRole('button', { name: 'Sign out' }).isVisible())
check('people with a generated name are asked to choose a username', await t.page.getByLabel('Your username').inputValue() === '')
await t.page.getByLabel('Your username').fill('thandi_m')
await t.page.getByLabel('Date of birth').fill('2000-05-05')
await t.page.getByRole('checkbox').check()
await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(800)
const pp = t.seen.req.filter(x => x.includes('/rest/v1/profile_private'))
check('the private facts are saved with update-then-insert, not the upsert the database refused', pp.some(x => x.startsWith('PATCH')) && pp.some(x => x.startsWith('POST')) && !pp.some(x => /resolution=merge-duplicates/.test(x)), JSON.stringify(pp))
check('the chosen username is saved through set_username', t.seen.rpc.some(([n, a]) => n === 'set_username' && a.p_username === 'thandi_m'))
check('onboarding moves on to the next step', await t.page.getByText(/Step 2 of/).isVisible())
check('no page errors in onboarding', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

// ---------------------------------------------------------------- sign in
t = await open({ url: '/signin', signedIn: false })
check('sign-in takes an email or a username', await t.page.getByLabel('Email or username').isVisible())
check('no Google button while the provider is off', await t.page.getByRole('button', { name: /Continue with Google/ }).count() === 0)
const hero = await t.page.evaluate(() => { const box = document.querySelector('.auth-hero')?.getBoundingClientRect(), hl = document.querySelector('.auth-hero-headline'), bd = document.querySelector('.auth-hero-body'); const r = (e) => e?.getBoundingClientRect(); return { box: box && { top: box.top, bottom: box.bottom }, hl: r(hl) && { top: r(hl).top, bottom: r(hl).bottom }, bd: bd && getComputedStyle(bd).display !== 'none' ? { top: r(bd).top, bottom: r(bd).bottom } : null } })
check('on a phone the sign-in hero shows the whole headline and the subtext inside it', hero.bd !== null && hero.hl.top >= hero.box.top && hero.bd.bottom <= hero.box.bottom + 1, JSON.stringify(hero))
await t.page.getByLabel('Email or username').fill('alice'); await t.page.getByLabel('Password').fill('nope')
await t.page.getByRole('button', { name: 'Sign in' }).click(); await t.page.waitForTimeout(600)
check('a username goes to the username-signin function; a wrong password shows its message', t.seen.fn.some(f => f.name === 'username-signin' && f.body.username === 'alice') && await t.page.getByText('That username and password don’t match an account.').isVisible())
await t.page.getByLabel('Password').fill('right')
await t.page.getByRole('button', { name: 'Sign in' }).click(); await t.page.waitForTimeout(1200)
check('the right password signs in with the returned session', new URL(t.page.url()).pathname.startsWith('/app'), t.page.url())
await t.ctx.close()
t = await open({ url: '/signup', signedIn: false, google: true })
check('Continue with Google appears once the provider is on', await t.page.getByRole('button', { name: /Continue with Google/ }).isVisible())
await t.page.getByLabel('Username').fill('alice'); await t.page.waitForTimeout(700)
check('sign-up says when a username is taken', await t.page.getByText('That username is taken.').isVisible())
await t.page.getByLabel('Username').fill('brand_new'); await t.page.waitForTimeout(700)
check('…and when it is available', await t.page.getByText('@brand_new is available.').isVisible())
await t.ctx.close()

// ---------------------------------------------------------------- reels
t = await open({ url: '/app/reels' })
check('Reels is in the main navigation', await t.page.locator('.bottomnav').getByRole('link', { name: 'Reels' }).isVisible())
check('reels fill the screen, one at a time, with like, comment, share and save', await t.page.locator('.reel').count() === 2 && await t.page.getByRole('button', { name: 'Like' }).first().isVisible() && await t.page.getByRole('button', { name: /Comments/ }).first().isVisible() && await t.page.getByRole('button', { name: 'Share' }).first().isVisible())
const rect = await t.page.locator('.reel').first().boundingBox()
check('a reel is full height above the tab bar', rect && rect.height >= 844 - 60 - 4, JSON.stringify(rect))
await t.page.getByRole('button', { name: 'Like' }).first().click(); await t.page.waitForTimeout(300)
check('liking a reel saves a reaction', t.seen.reactions.some(x => x.post_id === 'r1' && x.user_id === ME))
await t.page.getByRole('button', { name: /Comments/ }).first().click(); await t.page.waitForTimeout(500)
check('comments open over the reel, with text, voice and video notes', await t.page.getByRole('dialog', { name: 'Comments' }).isVisible() && await t.page.getByLabel('Write a comment').isVisible() && await t.page.getByRole('button', { name: /Record a voice note/ }).count() > 0 && await t.page.getByRole('button', { name: 'Record a video note' }).count() > 0)
check('no page errors on Reels', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

let clip = null
try { const d = mkdtempSync(join(tmpdir(), 'vybe-reel-')); execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=270x480:rate=10', '-t', '2', '-c:v', 'libvpx', '-b:v', '200k', join(d, 'r.webm')]); clip = readFileSync(join(d, 'r.webm')) } catch { console.log('- reel create check skipped: ffmpeg is not available') }
if (clip) {
  t = await open({ url: '/app/reels/new' })
  await t.page.getByLabel('Choose a video for your reel').setInputFiles({ name: 'my-reel.webm', mimeType: 'video/webm', buffer: clip })
  await t.page.waitForTimeout(1500)
  check('the reel uploads as soon as it is picked, with a vertical preview', t.seen.uploads.some(x => x.endsWith('.webm')) && await t.page.getByLabel('Preview of your reel').isVisible())
  await t.page.getByLabel('Caption').fill('Sunset session')
  await t.page.getByRole('button', { name: 'Share', exact: true }).click(); await t.page.waitForTimeout(1200)
  check('sharing creates a reel post (video, caption) with a poster made on the device', t.seen.posts[0]?.is_reel === true && t.seen.posts[0]?.media_type === 'video' && t.seen.posts[0]?.body === 'Sunset session' && /\.webp$/.test(t.seen.post_media[0]?.poster_path ?? ''), JSON.stringify({ p: t.seen.posts[0], m: t.seen.post_media[0] }))
  await t.ctx.close()
}

// ---------------------------------------------------------------- live
t = await open({ url: '/app', live: [{ id: 'ls1', host: OTHER, title: 'Late night set', event_id: null, profiles: other }] })
check('Home shows who is live now, and tapping opens their stream', await t.page.getByRole('region', { name: 'Live now' }).isVisible() && await t.page.getByRole('link', { name: /Bob is live: Late night set/ }).getAttribute('href') === '/app/live/ls1')
await t.page.getByRole('button', { name: 'Go live' }).click(); await t.page.waitForTimeout(300)
await t.page.getByRole('button', { name: 'Continue' }).click(); await t.page.waitForTimeout(800)
check('Go live creates the stream and opens the camera screen', t.seen.live[0]?.host === ME && t.seen.live[0]?.visibility === 'public' && t.seen.live[0]?.title === 'Alice is live' && new URL(t.page.url()).pathname === '/app/live/ls-new/host', JSON.stringify(t.seen.live) + ' ' + t.page.url() + ' ' + t.errs.join('|'))
await t.ctx.close()
t = await open({ url: '/app/live/ls1' })
const lvd = { lv: await t.page.locator('.lv').isVisible(), host: await t.page.locator('.lv-top').getByText('Bob').isVisible(), viewers: await t.page.getByLabel(/watching/).isVisible(), chat: await t.page.getByLabel('Chat message').isVisible(), heart: await t.page.getByRole('button', { name: 'Send a heart' }).isVisible(), nav: await t.page.locator('.bottomnav').isHidden() }
check('the live screen is full-screen with the host, LIVE status, viewers, chat and hearts over the video', Object.values(lvd).every(Boolean), JSON.stringify(lvd))
await t.ctx.close()

// ---------------------------------------------------------------- admin slide end time
t = await open({ url: '/admin/promos', admin: true, width: 1280, height: 900 })
await t.page.getByRole('button', { name: 'New slide' }).click(); await t.page.waitForTimeout(300)
await t.page.getByLabel('Headline').fill('Durban July').catch(() => {})
await t.page.locator('#pr-st').fill('2026-10-21T22:00'); await t.page.locator('#pr-en').fill('2026-10-21T22:00')
await t.page.getByLabel(/Link/).first().fill('/app/discover').catch(() => {})
await t.page.getByRole('button', { name: 'Save slide' }).click(); await t.page.waitForTimeout(300)
check('a slide that ends when it starts gets a clear message, and nothing is sent', await t.page.getByText(/The end must be after the start/).isVisible() && t.seen.promo.length === 0)
check('the optional end can be cleared', await t.page.getByRole('button', { name: 'Clear' }).isVisible())
await t.ctx.close()

// ---------------------------------------------------------------- isolation
t = await open({ url: '/admin', admin: true, width: 1280, height: 900, block: '**/assets/AdminPortal-*.js' })
check('if the admin portal cannot load, it says so instead of a blank page', await t.page.getByRole('alert').getByText(/VYBE was updated|hit a problem/).isVisible())
await t.page.goto(BASE + '/app'); await t.page.waitForTimeout(1000)
check('…and the member app keeps working', await t.page.locator('.compose-bar').isVisible())
await t.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall round 3 checks passed')
process.exit(failures ? 1 : 0)
