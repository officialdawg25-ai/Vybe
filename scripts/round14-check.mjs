// Post media frames (Instagram rule: full width, ratio clamped to 4:5 … 1.91:1, media fills edge to edge) against a MOCKED backend.
// SHOTS=<dir> saves a screenshot. Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }
const SHAPES = { tall: [900, 1600], wide: [1800, 600], square: [1000, 1000], portrait: [800, 1000] }   // 9:16, 3:1, 1:1, 4:5
const mk = (id, shape, extra = []) => ({ id, author: OTHER, body: `${shape} photo`, media_path: `${OTHER}/${shape}.png`, media_type: 'image', visibility: 'public', community_id: null, event_id: null, created_at: new Date(Date.now() - extra.length * 1000 - Object.keys(SHAPES).indexOf(shape) * 60000).toISOString(), edited_at: null, profiles: other, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], post_media: [shape, ...extra].map((s, i) => ({ path: `${OTHER}/${s}.png`, type: 'image', sort: i })) })
const posts = [mk('p1', 'tall'), mk('p2', 'wide'), mk('p3', 'square'), mk('p4', 'portrait'), mk('p5', 'square', ['tall', 'wide'])]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

// Real PNGs of each shape, drawn in the browser.
const gen = await browser.newPage()
const png = Object.fromEntries(await Promise.all(Object.entries(SHAPES).map(async ([k, [w, h]]) => [k, Buffer.from(await gen.evaluate(([w, h, k]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d')
  g.fillStyle = '#c4491c'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffe9a8'; g.fillRect(0, 0, 40, h); g.fillRect(w - 40, 0, 40, h)   // bright edges: any gutter or crop-at-edge is visible
  g.fillStyle = '#111'; g.font = `${Math.min(w, h) / 4}px sans-serif`; g.fillText(k, w / 8, h / 2); return c.toDataURL('image/png').split(',')[1]
}, [w, h, k]), 'base64')])))
await gen.close()

const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } })
await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
await ctx.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
  const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
  const p = u.pathname
  let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
  if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST' && Array.isArray(body?.paths)) return json(body.paths.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
  if (p.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `/object/sign/media/${decodeURIComponent(p.split('/media/')[1])}?token=t` })
  if (p.startsWith('/storage/v1/object/sign/media/')) { const k = Object.keys(SHAPES).find(s => p.includes(`/${s}.png`)); return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: png[k ?? 'square'] }) }
  if (p === '/rest/v1/rpc/my_profile') return json(me)
  if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin') return json(false)
  if (p === '/rest/v1/rpc/sponsored_feed') return json([])
  if (p === '/rest/v1/posts') return json(posts)
  if (p === '/rest/v1/profiles') { const id = u.searchParams.get('id')?.replace('eq.', ''); return json(obj ? me : id ? [id === OTHER ? other : me] : [me, other]) }
  return json(obj ? null : [])
})
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
await page.goto(BASE + '/app'); await page.waitForSelector('.igp-media'); await page.waitForTimeout(800)
// Scroll through the feed like a reader would, so every lazy picture is loaded before its frame is measured.
for (const el of await page.$$('.igp-media')) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(400) }
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300)
const frames = await page.$$eval('.igp-media', els => els.map(e => { const r = e.getBoundingClientRect(), img = e.querySelector('.igp-slide img'), ir = img?.getBoundingClientRect(); return { w: r.width, h: r.height, ratio: r.width / r.height, imgW: ir?.width ?? 0, imgH: ir?.height ?? 0, fit: img ? getComputedStyle(img).objectFit : '', page: document.documentElement.clientWidth } }))
if (process.env.DEBUG) console.log(JSON.stringify(await page.$$eval('article.igp', els => els.map(e => ({ cap: e.querySelector('.igp-caption')?.textContent?.slice(0, 24), cls: e.querySelector('.igp-media')?.className, ar: e.querySelector('.igp-media')?.style.aspectRatio })))))
const near = (a, b) => Math.abs(a - b) < 0.03
check('five posts render', frames.length === 5, String(frames.length))
check('every frame is as wide as the screen (no side gutters)', frames.every(f => Math.abs(f.w - f.page) < 1), frames.map(f => Math.round(f.w)).join(','))
check('tall (9:16) is cropped to 4:5, never taller', near(frames[0].ratio, 0.8), frames[0].ratio.toFixed(3))
check('wide (3:1) is cropped to 1.91:1, never wider', near(frames[1].ratio, 1.91), frames[1].ratio.toFixed(3))
check('square stays square', near(frames[2].ratio, 1), frames[2].ratio.toFixed(3))
check('4:5 stays 4:5', near(frames[3].ratio, 0.8), frames[3].ratio.toFixed(3))
check('a carousel follows its first item and fills every slide', near(frames[4].ratio, 1) && frames[4].imgW > 0, frames[4].ratio.toFixed(3))
check('pictures fill the whole frame (cover, same size as the frame)', frames.every(f => f.fit === 'cover' && Math.abs(f.imgW - f.w) < 1 && Math.abs(f.imgH - f.h) < 1))
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/media-frames.png`, fullPage: false })
check('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
