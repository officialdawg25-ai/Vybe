// Touch devices get no sticky hover or grey tap highlight; a like is saved and fills the heart. MOCKED backend.
// Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174).
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
const axe = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const post = { id: 'p1', author: OTHER, body: 'a post to like', media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: new Date().toISOString(), edited_at: null, profiles: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }, reactions: [{ count: 4 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [], post_media: [] }
const mk = async opts => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts })
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  const seen = { reactions: [] }
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object'), p = u.pathname
    let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
    if (p === '/rest/v1/rpc/my_profile') return json(me)
    if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin') return json(false)
    if (p === '/rest/v1/rpc/sponsored_feed') return json([])
    if (p === '/rest/v1/reactions' && r.method() === 'POST') { seen.reactions.push(body); return json([], 201) }
    if (p === '/rest/v1/posts') return json(obj ? post : [post])
    if (p === '/rest/v1/profiles') return json(obj ? me : [me])
    return json(obj ? null : [])
  })
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
  return { ctx, page, seen, errors }
}
let t = await mk({})
await t.page.goto(BASE + '/app'); await t.page.waitForSelector('.igp-act', { timeout: 10000 })
await t.page.getByRole('button', { name: 'Like', exact: true }).first().click(); await t.page.waitForTimeout(900)
check('a like fills the heart', await t.page.locator('.igp-act svg.liked, .igp-act svg.heart-pop').count() >= 1)
check('the like was saved', t.seen.reactions.length === 1 && t.seen.reactions[0].post_id === 'p1')
check('no grey tap highlight', await t.page.evaluate(() => /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(document.documentElement).getPropertyValue('-webkit-tap-highlight-color'))))
check('no page errors', t.errors.length === 0, t.errors.join(' | '))
await t.ctx.close()
t = await mk({ hasTouch: true, isMobile: true })
await t.page.goto(BASE + '/app/plans'); await t.page.waitForSelector('.btn')
check('touch devices report no hover', await t.page.evaluate(() => !matchMedia('(hover: hover)').matches))
const bg0 = await t.page.locator('.btn').first().evaluate(e => getComputedStyle(e).backgroundColor)
await t.page.locator('.btn').first().hover({ force: true }); await t.page.waitForTimeout(250)
const bg1 = await t.page.locator('.btn').first().evaluate(e => getComputedStyle(e).backgroundColor)
check('a pointer left over a button does not leave a hover colour behind', bg0 === bg1, `${bg0} → ${bg1}`)
await t.ctx.close()
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All touch checks passed')
