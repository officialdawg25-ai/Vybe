// Checks the Home billboard against a MOCKED backend: fits the screen on phone/desktop, trending plays first,
// sponsored slides interleave and are labelled, controls work, clicks are counted, unsafe links never render, and with no data it
// shows VYBE's own house slide (never a blank box). Also checks the Discover hero placement.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: 'Cape Town', interests: [], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const trend = n => ({ id: `e${n}`, title: `Trending ${n}`, starts_at: later, timezone: 'UTC', city: 'Cape Town', venue: 'Clifton', cover_path: null, going: 9, price_from_cents: 15000, trending: true, score: 20 })
const slide = (n, url = '/app/discover') => ({ id: `s${n}`, advertiser: 'Acme', title: `Sponsored ${n}`, subtitle: 'Offer', cta_label: 'Book', cta_url: url, media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'chime', city: null, priority: 50 })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null)
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ width, height = 760, trending = [trend(1), trend(2)], slides = [slide(1)], autoplay = 3000, rpcFail = false, path = '/app' }) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const tracked = []
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const rpc = u.pathname.replace('/rest/v1/rpc/', '')
    if (rpc === 'home_hero_settings') return rpcFail ? json({ message: 'x' }, 500) : json({ trending_enabled: true, max_trending: 5, autoplay_ms: autoplay, sponsored_every: 3 })
    if (rpc === 'trending_events') return rpcFail ? json({ message: 'x' }, 500) : json(trending)
    if (rpc === 'promo_track') { tracked.push(JSON.parse(r.postData() ?? '{}')); return json(true) }
    if (u.pathname === '/rest/v1/promo_slides') {
      if (rpcFail) return json({ message: 'x' }, 500)
      const want = (u.searchParams.get('placements') ?? '').match(/\{(\w+)\}/)?.[1]
      return json(want ? slides.filter(x => (x.placements ?? ['home']).includes(want)) : slides)
    }
    if (u.pathname === '/rest/v1/profiles') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify((r.headers().accept ?? '').includes('vnd.pgrst.object') ? me : [me]) })
    return json((r.headers().accept ?? '').includes('vnd.pgrst.object') ? null : [])
  })
  const page = await ctx.newPage()
  await page.goto(BASE + path); await page.waitForTimeout(900)
  return { page, ctx, tracked }
}
const box = async page => page.locator('.billboard').boundingBox()
const title = async page => (await page.locator('.bb-title').first().textContent())?.trim()

for (const [w, h] of [[375, 667], [375, 812], [768, 1024], [1280, 800], [812, 375]]) {
  const t = await open({ width: w, height: h })
  const b = await box(t.page)
  check(`fits ${w}×${h}: billboard ≤ 36% of height and within width`, !!b && b.height <= h * 0.36 && b.height >= 120 && b.width <= w + 1, b ? `${Math.round(b.height)}px tall` : 'missing')
  check(`no horizontal overflow at ${w}×${h}`, !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
  const comp = await t.page.locator('.compose-bar').boundingBox()
  check(`billboard sits above the composer at ${w}×${h}`, !!b && !!comp && b.y + b.height <= comp.y)
  await t.ctx.close()
}

let t = await open({ width: 1280 })
check('trending plays first', (await title(t.page)) === 'Trending 1' && (await t.page.locator('.bb-eyebrow').first().textContent())?.includes('Trending near'))
await t.page.waitForTimeout(3400)
check('auto-advances', (await title(t.page)) === 'Trending 2')
await t.page.waitForTimeout(3400)
check('sponsored slide is interleaved and labelled', (await title(t.page)) === 'Sponsored 1' && (await t.page.locator('.bb-ad').textContent())?.startsWith('Sponsored'))
check('impression counted once for the sponsored slide', t.tracked.filter(x => x.p_kind === 'impression' && x.p_slide === 's1').length === 1, JSON.stringify(t.tracked))
await t.page.getByRole('button', { name: 'Pause slideshow' }).click()
await t.page.mouse.move(0, 0)
await t.page.waitForTimeout(3500)
check('pause stops rotation', (await title(t.page)) === 'Sponsored 1')
await t.page.getByRole('button', { name: 'Next slide' }).click({ force: true })
check('next control works', (await title(t.page)) === 'Trending 1')
await t.page.getByRole('button', { name: 'Show slide 3' }).click()
await t.page.locator('a.bb-slide').click()
await t.page.waitForTimeout(300)
check('click counted and navigates in-app', t.tracked.some(x => x.p_kind === 'click' && x.p_slide === 's1') && new URL(t.page.url()).pathname === '/app/discover')
await t.ctx.close()

const house = async page => (await title(page)) === 'Life is better together' && (await page.locator('.bb-eyebrow').first().textContent()) === 'From VYBE'
t = await open({ width: 375, slides: [slide(1, 'javascript:alert(1)')], trending: [] })
check('an unsafe link never renders; VYBE’s house slide stands in', await house(t.page) && await t.page.locator('a[href^="javascript"]').count() === 0)
await t.ctx.close()

t = await open({ width: 375, slides: [], trending: [] })
await shot(t.page, 'home-billboard-house')
check('nothing live: the billboard keeps its place with VYBE’s house slide, labelled “From VYBE”, not “Sponsored”', await house(t.page) && await t.page.locator('.bb-ad').count() === 0 && await t.page.locator('.compose-bar').isVisible())
check('house slides are never counted as ad impressions', t.tracked.length === 0, JSON.stringify(t.tracked))
await t.ctx.close()

t = await open({ width: 375, rpcFail: true })
check('backend failure: house slide, Home still works', await house(t.page) && await t.page.locator('.compose-bar').isVisible())
await t.ctx.close()

t = await open({ width: 375, trending: [], slides: [{ ...slide(7), kind: 'house', title: 'Our own news' }, { ...slide(8), placements: ['discover'], title: 'Discover only' }] })
check('a house slide from the admin says “From VYBE”; Discover-only slides stay off Home', (await title(t.page)) === 'Our own news' && (await t.page.locator('.bb-eyebrow').first().textContent()) === 'From VYBE' && await t.page.locator('.bb-dots button').count() === 0)
await t.ctx.close()

/* Discover hero */
for (const [w, h] of [[375, 812], [1280, 800]]) {
  t = await open({ width: w, height: h, path: '/app/discover', slides: [{ ...slide(3), placements: ['discover'], title: 'Festival weekend' }, { ...slide(4), placements: ['home', 'discover'], kind: 'announcement', title: 'New: tickets in chat' }, { ...slide(5), title: 'Home only' }] })
  const hb = await t.page.locator('.billboard.bb-discover').boundingBox(), head = await t.page.locator('.shz-head').boundingBox()
  await shot(t.page, `discover-hero-${w}`)
  // Taller than the Home billboard on purpose (requested on 2026-10-22), but never more than about half the screen.
  check(`Discover hero sits at the top of Discover at ${w}×${h}, within width and ≤ 53% of height`, !!hb && !!head && hb.y < head.y && hb.width <= w + 1 && hb.height <= h * 0.53, JSON.stringify(hb))
  check(`Discover hero shows only Discover slides, each labelled at ${w}×${h}`, (await title(t.page)) === 'Festival weekend' && (await t.page.locator('.bb-eyebrow').first().textContent()) === 'Sponsored · Acme' && await t.page.locator('.bb-dots button').count() === 2)
  check(`no horizontal overflow on Discover at ${w}×${h}`, !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
  await t.page.getByRole('button', { name: 'Show slide 2' }).click()
  check('announcement slides are labelled as VYBE news', (await t.page.locator('.bb-eyebrow').first().textContent()) === 'VYBE announcement')
  await t.ctx.close()
}
t = await open({ width: 375, path: '/app/discover', slides: [] })
await shot(t.page, 'discover-hero-house')
check('Discover with nothing live shows VYBE’s house hero, not an empty box', (await title(t.page)) === 'Discover what moves you' && (await t.page.locator('.bb-eyebrow').first().textContent()) === 'From VYBE')
await t.ctx.close()
t = await open({ width: 375, path: '/app/discover?mode=events', slides: [{ ...slide(3), placements: ['discover'] }] })
check('the hero belongs to Discover’s main view, not to search results', await t.page.locator('.billboard').count() === 0)
await t.ctx.close()

const rm = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
await rm.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
await rm.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const rpc = u.pathname.replace('/rest/v1/rpc/', '')
  const body = rpc === 'trending_events' ? [trend(1), trend(2)] : rpc === 'home_hero_settings' ? { autoplay_ms: 3000 } : u.pathname === '/rest/v1/promo_slides' ? [] : u.pathname === '/rest/v1/profiles' ? [me] : []
  return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(body) })
})
const rp = await rm.newPage(); await rp.goto(BASE + '/app'); await rp.waitForTimeout(4500)
check('reduced motion: no auto-rotation', (await title(rp)) === 'Trending 1')
await rm.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall billboard checks passed')
process.exit(failures ? 1 : 0)
