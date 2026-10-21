// Checks the Home billboard against a MOCKED backend: fits the screen on phone/desktop, trending plays first,
// sponsored slides interleave and are labelled, controls work, clicks are counted, unsafe links never render, and it hides cleanly with no data.
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
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ width, height = 760, trending = [trend(1), trend(2)], slides = [slide(1)], autoplay = 3000, rpcFail = false }) {
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
    if (u.pathname === '/rest/v1/promo_slides') return rpcFail ? json({ message: 'x' }, 500) : json(slides)
    if (u.pathname === '/rest/v1/profiles') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify((r.headers().accept ?? '').includes('vnd.pgrst.object') ? me : [me]) })
    return json((r.headers().accept ?? '').includes('vnd.pgrst.object') ? null : [])
  })
  const page = await ctx.newPage()
  await page.goto(BASE + '/app'); await page.waitForTimeout(900)
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

t = await open({ width: 375, slides: [slide(1, 'javascript:alert(1)')], trending: [] })
check('unsafe link never renders: the slide is dropped and VYBE’s own card shows instead', await t.page.locator('a[href^="javascript"]').count() === 0 && await t.page.locator('.billboard .bb-house').count() === 1 && await t.page.getByText('Sponsored 1').count() === 0)
await t.ctx.close()

t = await open({ width: 375, slides: [], trending: [] })
check('empty billboard keeps its place with VYBE’s own card, labelled as VYBE’s (Home still works)', await t.page.locator('.billboard .bb-house').count() === 1 && await t.page.locator('.billboard .bb-ad').count() === 0 && await t.page.locator('.compose-bar').isVisible())
await t.ctx.close()

t = await open({ width: 375, rpcFail: true })
check('backend failure shows VYBE’s own card, never a broken slide, and Home works', await t.page.locator('.billboard .bb-house').count() === 1 && await t.page.locator('.compose-bar').isVisible())
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
