// Plans and Communities as poster grids, a community page with cover + picture + owner controls, clean suggestion cards on Home. MOCKED backend.
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
const COM = 'cccccccc-0000-4000-8000-0000000000c1', COM2 = 'cccccccc-0000-4000-8000-0000000000c2'
const later = new Date(Date.now() + 864e5 * 3).toISOString()
const plans = [1, 2, 3].map(n => ({ id: `e${n}`, host: OTHER, title: `Sunset session ${n}`, description: '', cover_path: n === 1 ? `${OTHER}/cover.png` : null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Clifton, Cape Town', visibility: 'public', capacity: null, price_cents: n === 2 ? 15000 : 0, currency: 'ZAR', status: 'active', profiles: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null } }))
let coms = [
  { id: COM, name: 'Cape Town Runners', description: 'We run every Saturday', rules: 'Be kind', cover_path: `${OTHER}/cover.png`, avatar_path: `${OTHER}/pic.png`, topics: ['Sports'], visibility: 'public', created_by: ME, post_policy: 'members' },
  { id: COM2, name: 'Vinyl Club', description: '', rules: '', cover_path: null, avatar_path: null, topics: ['Music', 'Art'], visibility: 'private', created_by: OTHER, post_policy: 'members' },
]
const members = { [COM]: [{ community_id: COM, user_id: ME, role: 'owner', status: 'active', profiles: me }, { community_id: COM, user_id: OTHER, role: 'member', status: 'pending', profiles: other }], [COM2]: [{ community_id: COM2, user_id: OTHER, role: 'owner', status: 'active', profiles: other }] }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const gen = await browser.newPage()
const png = Buffer.from(await gen.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); const l = g.createLinearGradient(0, 0, 1200, 800); l.addColorStop(0, '#2dd4bf'); l.addColorStop(1, '#4338ca'); g.fillStyle = l; g.fillRect(0, 0, 1200, 800); return c.toDataURL('image/png').split(',')[1] }), 'base64')
await gen.close()
const seen = { patches: [], uploads: 0 }
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
await ctx.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
  const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
  const p = u.pathname, q = u.searchParams
  let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
  if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST' && Array.isArray(body?.paths)) return json(body.paths.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
  if (p.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `/object/sign/media/${decodeURIComponent(p.split('/media/')[1])}?token=t` })
  if (p.startsWith('/storage/v1/object/sign/media/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: png })
  if (p.startsWith('/storage/v1/object/media/') && r.method() === 'POST') { seen.uploads++; return json({ Key: 'ok' }) }
  if (p.startsWith('/storage/v1/object/media') && r.method() === 'DELETE') return json([])
  if (p === '/rest/v1/rpc/my_profile') return json(me)
  if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin') return json(false)
  if (p === '/rest/v1/events') return json(plans)
  if (p === '/rest/v1/event_rsvps') return json([])
  if (p === '/rest/v1/communities') {
    if (r.method() === 'PATCH') { seen.patches.push(body); Object.assign(coms[0], body); return json([coms[0]]) }
    const id = q.get('id')?.replace('eq.', '')
    if (id) { const c = coms.find(x => x.id === id); return json(obj ? c ?? null : c ? [c] : []) }
    return json(coms)
  }
  if (p === '/rest/v1/community_members') {
    const cid = (q.get('community_id') ?? '').startsWith('eq.') ? q.get('community_id').replace('eq.', '') : null
    if (cid) return json(members[cid] ?? [])
    return json([{ community_id: COM, status: 'active' }, { community_id: COM, status: 'active' }, { community_id: COM2, status: 'active' }].filter(() => true).concat([]))
  }
  if (p === '/rest/v1/profiles') return json(obj ? me : [me])
  if (p === '/rest/v1/posts') return json([])
  return json(obj ? null : [])
})
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
const scan = async () => { await page.evaluate(axe); return (await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 90)}`) }

await page.goto(BASE + '/app/plans'); await page.waitForSelector('.poster', { timeout: 10000 }); await page.waitForTimeout(600)
check('Plans uses the large page title and pill filters like Discover', await page.locator('h1.t-display-sm').textContent().then(x => x === 'Plans') && await page.locator('.dfilter').count() === 3)
check('every plan is a poster: date, title, place, price on the card, “by @host” under it', await page.locator('.poster').count() === 3 && await page.locator('.poster-art .poster-title').first().textContent().then(x => /Sunset session/.test(x ?? '')) && (await page.locator('.poster > .pc .pc-by').first().textContent()) === 'by @bob')
check('prices are real: Free and the paid one', (await page.locator('.poster-foot b').allTextContents()).some(x => x === 'Free') && (await page.locator('.poster-foot b').allTextContents()).some(x => /150/.test(x)))
check('the plan with artwork shows it on the poster', await page.locator('.poster-art').first().evaluate(e => getComputedStyle(e).backgroundImage.includes('cover.png')))
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/plans.png` })
let v = await scan(); check('axe: Plans', v.length === 0, v.join(' | '))

await page.goto(BASE + '/app/communities'); await page.waitForSelector('.cm-tile', { timeout: 10000 }); await page.waitForTimeout(600)
check('Communities uses the same title and filters', await page.locator('h1.t-display-sm').textContent().then(x => x === 'Communities') && await page.locator('.dfilter').count() === 2)
check('each community is a card: cover with picture, name, privacy and topics on it', await page.locator('.cm-tile').count() === 2 && await page.locator('.cm-tile .cm-pic').count() === 2 && (await page.locator('.cm-tile .poster-cat').allTextContents()).some(x => x.includes('Public')) && (await page.locator('.cm-tile .poster-cat').allTextContents()).some(x => x.includes('Private')))
check('real member counts are shown', await page.locator('.cm-tile .poster-line').first().textContent().then(x => /member/.test(x ?? '')))
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/communities.png` })
v = await scan(); check('axe: Communities', v.length === 0, v.join(' | '))

await page.goto(BASE + `/app/communities/${COM}`); await page.waitForSelector('.cm-card', { timeout: 10000 }); await page.waitForTimeout(700)
const hero = await page.locator('.cm-hero').evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, w: r.width, vw: innerWidth } })
check('the community page has a full-bleed cover from the top of the screen', hero.top <= 0.5 && Math.abs(hero.w - hero.vw) < 1, JSON.stringify(hero))
check('its picture sits on the cover and the name, privacy and member count follow', await page.locator('.cm-av').count() === 1 && (await page.locator('.cm-card .pf-name').textContent()) === 'Cape Town Runners' && /Public community · 1 member/.test(await page.locator('.cm-card .pf-handle').textContent() ?? ''))
check('the owner sees Manage, Share and a banner for the person waiting to join', await page.getByRole('button', { name: 'Manage community' }).isVisible() && await page.getByRole('button', { name: 'Share community' }).first().isVisible() && await page.getByText(/wants to join/).isVisible())
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/community.png` })
await page.getByRole('button', { name: 'Manage community' }).click()
await page.getByRole('button', { name: /Admins and moderators only/ }).click()
await page.getByLabel('Name').fill('Cape Town Runners Club')
await page.getByRole('button', { name: 'Save changes' }).click(); await page.waitForTimeout(700)
const patch = seen.patches[0] ?? {}
check('saving writes the name and who can post in one update', patch.name === 'Cape Town Runners Club' && patch.post_policy === 'admins' && patch.visibility === 'public', JSON.stringify(patch))
await page.locator('input[type=file]').first().setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png }).catch(() => {})
check('no page errors', errors.length === 0, errors.join(' | '))
v = await scan(); check('axe: community page', v.length === 0, v.join(' | '))
await ctx.close()
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All plans and communities checks passed')
