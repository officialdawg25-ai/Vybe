// Verifies how the sign-in hero behaves for each published configuration, against a MOCKED backend:
// image, video (desktop plays, phone gets the poster only), broken media (falls back, form still usable),
// backend failure (last good copy / default), and that signing in is never blocked by media.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const U = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
const IMG = { media_type: 'image', path: `hero/${U}.jpg`, focal_x: 20, focal_y: 70, overlay: 50, headline: 'Tonight, together.', body: 'Plans, people, places.' }
const VID = { media_type: 'video', path: `hero/${U}.mp4`, poster_path: `hero/${U.replace('3f2b', '4a4a')}.jpg`, focal_x: 50, focal_y: 50, overlay: 40, headline: 'Move with us', body: '' }
// 1x1 JPEG
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ width, hero, rpcStatus = 200, media = 'ok', url = '/signin', seed }) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } })
  await ctx.addInitScript(([s]) => { try { sessionStorage.setItem('vybe:splash:v1', '1'); if (s) localStorage.setItem('vybe:auth-hero', s) } catch {} }, [seed ?? null])
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    if (u.pathname === '/rest/v1/rpc/get_auth_hero') return route.fulfill({ status: rpcStatus, headers: h, contentType: 'application/json', body: rpcStatus === 200 ? JSON.stringify(hero ?? null) : '{"message":"boom"}' })
    if (u.pathname.startsWith('/storage/v1/object/public/brand/')) {
      if (media === 'broken') return route.fulfill({ status: 404, headers: h, body: 'nope' })
      if (u.pathname.endsWith('.mp4')) return // never answered: simulates a very slow video download
      return route.fulfill({ status: 200, headers: h, contentType: 'image/jpeg', body: JPG })
    }
    return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: '[]' })
  })
  const page = await ctx.newPage()
  await page.goto(BASE + url); await page.waitForTimeout(600)
  return { page, ctx }
}
const usable = async page => { await page.fill('#login', 'a@b.co'); await page.fill('#password', 'x'); return page.locator('button.btn.primary').isEnabled() }

let t = await open({ width: 1280, hero: IMG })
check('image hero: renders <img> with focal point', await t.page.locator('img.hero-fill').count() === 1 && (await t.page.locator('img.hero-fill').getAttribute('style')).includes('20% 70%'))
check('image hero: published headline shown', await t.page.getByText('Tonight, together.').isVisible())
check('image hero: sign-in form usable', await usable(t.page)); await t.ctx.close()

t = await open({ width: 1280, hero: VID })
check('video hero (desktop): muted looping inline <video> with poster', await t.page.locator('video.hero-fill').evaluate(v => v.muted && v.loop && v.playsInline && v.autoplay && Boolean(v.poster)))
check('video hero (desktop): form usable while the video is still downloading', await usable(t.page)); await t.ctx.close()

t = await open({ width: 375, hero: VID })
check('video hero (phone): no video requested, poster image only', await t.page.locator('video').count() === 0 && await t.page.locator('img.hero-fill').count() === 1); await t.ctx.close()

t = await open({ width: 1280, hero: IMG, media: 'broken' })
check('broken media: falls back to default art, headline still readable', await t.page.locator('img.hero-fill').count() === 0 && await t.page.getByText('Tonight, together.').isVisible())
check('broken media: form usable', await usable(t.page)); await t.ctx.close()

t = await open({ width: 1280, hero: null })
check('nothing published: built-in default headline', await t.page.getByText('Life is better together.').first().isVisible()); await t.ctx.close()

t = await open({ width: 1280, rpcStatus: 500, seed: JSON.stringify(IMG) })
check('backend error: last good copy (cache) still shown', await t.page.getByText('Tonight, together.').isVisible()); await t.ctx.close()

t = await open({ width: 1280, rpcStatus: 500 })
check('backend error, no cache: default hero, form usable', await t.page.getByText('Life is better together.').first().isVisible() && await usable(t.page)); await t.ctx.close()

t = await open({ width: 1280, hero: null, seed: JSON.stringify(IMG) })
check('unpublished: stale cache is cleared', await t.page.getByText('Tonight, together.').count() === 0); await t.ctx.close()

t = await open({ width: 1280, hero: { ...IMG, path: '../../etc/passwd' } })
check('malformed path from server is ignored (no media)', await t.page.locator('img.hero-fill').count() === 0 && await usable(t.page)); await t.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall hero checks passed')
process.exit(failures ? 1 : 0)
