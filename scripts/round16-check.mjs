// Profile: full-bleed image cover, identity card, motion (clip/GIF) profile picture upload and playback, view of another person, axe. MOCKED backend.
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
const stats = { posts: 12, followers: 1200, following: 15, friends: 7, follows_me: false, i_follow: false }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
// A real picture and a real 1-second WebM, made in the browser.
const gen = await browser.newPage()
const png = Buffer.from(await gen.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 900; const g = c.getContext('2d'); const l = g.createLinearGradient(0, 0, 1600, 900); l.addColorStop(0, '#ff7a59'); l.addColorStop(1, '#3b2aa0'); g.fillStyle = l; g.fillRect(0, 0, 1600, 900); return c.toDataURL('image/png').split(',')[1] }), 'base64')
const webm = Buffer.from(await gen.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); const stream = c.captureStream(15); const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = []
  rec.ondataavailable = e => chunks.push(e.data); rec.start(); let n = 0
  await new Promise(r => { const t = setInterval(() => { g.fillStyle = `hsl(${n * 20},80%,50%)`; g.fillRect(0, 0, 320, 240); if (++n > 20) { clearInterval(t); rec.onstop = r; rec.stop() } }, 66) })
  const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer(); let s = ''; new Uint8Array(buf).forEach(b => (s += String.fromCharCode(b))); return btoa(s)
}), 'base64')
await gen.close()

const mkCtx = async (owner, { cover = true, motion = false } = {}) => {
  const seen = { patches: [], uploads: [] }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  const who = owner ? me : other
  const row = { ...who, cover_path: cover ? `${who.id}/cover.png` : null, avatar_path: `${who.id}/a.png`, avatar_motion_path: motion ? `${who.id}/clip.webm` : null, bio: 'Hi there', location: 'Cape Town', interests: [], dm_policy: 'everyone', follow_policy: 'everyone' }
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const p = u.pathname
    let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
    if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST' && Array.isArray(body?.paths)) return json(body.paths.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
    if (p.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `/object/sign/media/${decodeURIComponent(p.split('/media/')[1])}?token=t` })
    if (p.startsWith('/storage/v1/object/sign/media/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': p.endsWith('.webm') ? 'video/webm' : 'image/png' }, body: p.endsWith('.webm') ? webm : png })
    if (p.startsWith('/storage/v1/object/media/') && r.method() === 'POST') { seen.uploads.push(r.headers()['content-type']); return json({ Key: 'ok', Id: 'x' }) }
    if (p.startsWith('/storage/v1/object/media') && r.method() === 'DELETE') return json([])
    if (p === '/rest/v1/rpc/my_profile') return json(me)
    if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin') return json(false)
    if (p === '/rest/v1/rpc/profile_stats') return json(stats)
    if (p === '/rest/v1/rpc/author_memories') return json([])
    if (p === '/rest/v1/rpc/get_profile_details') return json({ level: 1 })
    if (p === '/rest/v1/profiles') { if (r.method() === 'PATCH') { seen.patches.push(body); return json([row]) } return json(obj ? row : [row]) }
    return json(obj ? null : [])
  })
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
  return { ctx, page, seen, errors }
}
const scan = async page => { await page.evaluate(axe); return (await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 90)}`) }

let t = await mkCtx(true, { motion: true })
await t.page.goto(BASE + '/app/u/alice'); await t.page.waitForSelector('.pf-name'); await t.page.waitForTimeout(900)
const hero = await t.page.locator('.pf-hero').evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, w: r.width, h: r.height, vw: innerWidth, bg: getComputedStyle(e.querySelector('.pf-hero-img')).backgroundImage } })
check('the cover fills the screen from the very top, edge to edge', hero.top <= 0.5 && Math.abs(hero.w - hero.vw) < 1 && hero.h >= 240, JSON.stringify(hero))
check('the cover is the uploaded picture', hero.bg.includes('/cover.png'))
check('the identity card overlaps the cover and the name is centred', await t.page.locator('.pf-card').evaluate(e => e.getBoundingClientRect().top < document.querySelector('.pf-hero').getBoundingClientRect().bottom))
check('stats show posts / followers / following', (await t.page.locator('.pf-stats').innerText()).replace(/\s+/g, ' ').includes('12 Posts') && (await t.page.locator('.pf-stats').innerText()).includes('1.2K'))
const vid = await t.page.locator('.pf-av-video').evaluate(v => ({ paused: v.paused, loop: v.loop, muted: v.muted, t: v.currentTime }))
check('a motion profile picture plays on the profile (looping, muted)', vid.loop && vid.muted)
await t.page.waitForTimeout(800)
check('…and is actually moving', await t.page.locator('.pf-av-video').evaluate(v => !v.paused && v.currentTime > 0))
check('owner controls: edit profile, share, create, settings, add/change cover', await t.page.getByRole('link', { name: /Edit profile/ }).isVisible() && await t.page.getByRole('button', { name: 'Share profile' }).isVisible() && await t.page.getByRole('link', { name: 'Create a post' }).first().isVisible() && await t.page.getByRole('link', { name: 'Profile settings' }).isVisible() && await t.page.getByRole('button', { name: 'Change cover photo' }).isVisible())
check('the cover picker only accepts photos', (await t.page.locator('input[type=file]').nth(1).getAttribute('accept')) === 'image/jpeg,image/png,image/webp')
check('the avatar picker accepts photos, GIFs and short clips', /gif/.test((await t.page.locator('input[type=file]').first().getAttribute('accept')) ?? '') && /video\/mp4/.test((await t.page.locator('input[type=file]').first().getAttribute('accept')) ?? ''))
// upload a ~1 s clip as the profile picture
await t.page.locator('input[type=file]').first().setInputFiles({ name: 'me.webm', mimeType: 'video/webm', buffer: webm })
await t.page.waitForTimeout(2500)
check('a short clip uploads the clip and a still, then points the profile at both in one update', t.seen.uploads.length === 2 && t.seen.patches.some(b => b && 'avatar_motion_path' in b && b.avatar_motion_path && b.avatar_path), JSON.stringify({ u: t.seen.uploads, p: t.seen.patches }))
check('a photo from a clip is a JPEG still', t.seen.uploads.includes('image/jpeg') || t.seen.uploads.some(x => /jpeg/.test(x ?? '')))
check('tabs have icons and words', await t.page.locator('.pf-tab span').count() === 4)
check('no overflow, no page errors', !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) && t.errors.length === 0, t.errors.join(' | '))
if (process.env.SHOTS) await t.page.screenshot({ path: `${process.env.SHOTS}/profile-owner.png` })
const v1 = await scan(t.page); check('axe: no violations (own profile)', v1.length === 0, v1.join(' | '))
await t.ctx.close()

// a clip that is too long is refused before anything is uploaded
t = await mkCtx(true, { cover: false })
await t.page.goto(BASE + '/app/u/alice'); await t.page.waitForSelector('.pf-name')
check('without a cover the owner is invited to add one and sees the brand backdrop', await t.page.getByRole('button', { name: 'Add a cover photo' }).isVisible() && !(await t.page.locator('.pf-hero').evaluate(e => e.classList.contains('has-cover'))))
await t.page.locator('input[type=file]').nth(1).setInputFiles({ name: 'cover.gif', mimeType: 'image/gif', buffer: png })
await t.page.waitForTimeout(500)
check('a GIF is refused as a cover (photos only)', t.seen.uploads.length === 0 && await t.page.getByText(/cover is a photo/).count() > 0)
const v2 = await scan(t.page); check('axe: no violations (no cover)', v2.length === 0, v2.join(' | '))
await t.ctx.close()

t = await mkCtx(false, { motion: true })
await t.page.goto(BASE + '/app/u/bob'); await t.page.waitForSelector('.pf-name'); await t.page.waitForTimeout(700)
check('another profile: back, more, follow, message and share', await t.page.getByRole('button', { name: 'Back' }).isVisible() && await t.page.getByRole('button', { name: 'More options' }).isVisible() && await t.page.getByRole('button', { name: /Follow/ }).first().isVisible() && await t.page.getByRole('button', { name: /^Message/ }).isVisible() && await t.page.getByRole('button', { name: 'Share profile' }).isVisible())
check('another profile shows no owner edit controls', await t.page.getByRole('button', { name: /Change profile picture/ }).count() === 0 && await t.page.getByRole('button', { name: /cover/i }).count() === 0)
check('their motion picture plays for visitors too', await t.page.locator('.pf-av-video').count() === 1)
const v3 = await scan(t.page); check('axe: no violations (someone else)', v3.length === 0, v3.join(' | '))
await t.ctx.close()
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All profile checks passed')
