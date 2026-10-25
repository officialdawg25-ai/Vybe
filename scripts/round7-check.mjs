// Browser checks for photo display copies and field performance numbers, against a MOCKED backend (behaviour and the
// exact data sent, not the real database): the composer makes a ≤1080 px WebP copy of a big photo on the device and links
// it to the post; an older server without the column still gets the post (and the copy is deleted); feeds and the profile
// grid show copies (High quality shows originals); sampled sessions send only numbers and coarse buckets; Admin →
// Performance shows the percentiles.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const gallery = [{ path: `${OTHER}/big.jpg`, type: 'image', sort: 0, poster_path: null, display_path: `${OTHER}/big-d.webp` }, { path: `${OTHER}/old.jpg`, type: 'image', sort: 1, poster_path: null, display_path: null }]
const photoPost = { id: 'eeeeeeee-0000-4000-8000-000000000001', author: OTHER, body: 'Two photos', media_path: `${OTHER}/big.jpg`, media_type: 'image', visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: other, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], tags: [], post_media: gallery }
const videoCell = { id: 'eeeeeeee-0000-4000-8000-000000000002', body: 'Clip', created_at: now, media_path: `${OTHER}/v.mp4`, media_type: 'video', reactions: [{ count: 0 }], post_media: [{ path: `${OTHER}/v.mp4`, type: 'video', sort: 0, poster_path: `${OTHER}/v-poster.webp`, display_path: null }] }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ url = '/app', width = 390, height = 844, noDisplayColumn = false, sampled = null, mode = null, admin = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const seen = { uploads: [], deletes: [], post_media: [], signed: [], fetched: [], metrics: [], summary: 0 }
  await ctx.addInitScript(([s, sampled, mode]) => {
    try {
      sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s)
      if (sampled != null) sessionStorage.setItem('vybe:metrics-sampled', sampled)
      if (mode) localStorage.setItem('vybe:data-mode', mode)
    } catch {}
  }, [JSON.stringify(session), sampled, mode])
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    if (u.pathname === '/storage/v1/object/sign/media' && r.method() === 'POST') { const ps = body()?.paths ?? []; seen.signed.push(...ps); return json(ps.map(p => ({ path: p, signedURL: `/object/sign/media/${p}?token=t`, error: null }))) }
    if (u.pathname.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') { const p = decodeURIComponent(u.pathname.replace('/storage/v1/object/sign/media/', '')); seen.signed.push(p); return json({ signedURL: `/object/sign/media/${p}?token=t` }) }
    if (u.pathname.startsWith('/storage/v1/object/sign/media/') && r.method() === 'GET') { seen.fetched.push(decodeURIComponent(u.pathname.split('/media/')[1])); return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG }) }
    if (u.pathname.startsWith('/storage/v1/object/media') && r.method() === 'DELETE') { seen.deletes.push(...(body()?.prefixes ?? [])); return json([]) }
    if (u.pathname.startsWith('/storage/v1/object/media/') && r.method() === 'POST') {
      seen.uploads.push({ path: decodeURIComponent(u.pathname.replace('/storage/v1/object/media/', '')), type: r.headers()['content-type'] ?? '', body: r.postDataBuffer() ?? Buffer.alloc(0) })
      return json({ Key: 'ok' })
    }
    if (u.pathname === '/rest/v1/rpc/record_client_metrics') { seen.metrics.push({ body: body(), auth: r.headers().authorization ?? '' }); return json(1) }
    if (u.pathname === '/rest/v1/rpc/client_metrics_summary') { seen.summary++; return json([{ name: 'lcp', route: 'home', mode: 'auto', n: 42, p50: 1810, p75: 2390, p95: 4100 }, { name: 'cls', route: 'home', mode: 'auto', n: 42, p50: 0.01, p75: 0.04, p95: 0.12 }, { name: 'reel_start', route: 'reels', mode: 'saver', n: 3, p50: 900, p75: 1300, p95: 2100 }]) }
    if (u.pathname === '/rest/v1/rpc/my_profile') return json(me)
    if (u.pathname === '/rest/v1/rpc/my_roles' || u.pathname === '/rest/v1/rpc/is_admin') return json(admin)
    if (u.pathname === '/rest/v1/staff') return json(admin ? (obj ? { role: 'admin' } : [{ user_id: ME, role: 'admin' }]) : (obj ? null : []))
    if (u.pathname === '/rest/v1/profiles') return json(obj ? (u.searchParams.get('username') === 'eq.bob' ? { ...other, bio: '', cover_path: null, interests: [], show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone', verified_until: null } : me) : [me])
    if (u.pathname === '/rest/v1/post_media' && r.method() === 'POST') {
      const rows = body() ?? []
      if (noDisplayColumn && rows.some(x => 'display_path' in x)) return json({ code: 'PGRST204', message: "Could not find the 'display_path' column of 'post_media' in the schema cache" }, 400)
      seen.post_media.push(rows); return route.fulfill({ status: 201, headers: h, body: '' })
    }
    if (u.pathname === '/rest/v1/posts' && r.method() === 'POST') return json(obj ? { id: 'new-post' } : [{ id: 'new-post' }], 201)
    if (u.pathname === '/rest/v1/posts' && r.method() === 'GET') {
      if ((u.searchParams.get('select') ?? '').startsWith('id,body,created_at')) return json([{ id: photoPost.id, body: 'Two photos', created_at: now, media_path: photoPost.media_path, media_type: 'image', reactions: [{ count: 0 }], post_media: gallery }, videoCell])
      if (u.searchParams.get('id') === 'eq.new-post') return json(obj ? { ...photoPost, id: 'new-post', author: ME, profiles: me } : [])
      return json(u.searchParams.get('is_reel') || u.searchParams.has('or') || u.searchParams.has('created_at') ? [] : [photoPost])
    }
    if (u.pathname.startsWith('/rest/v1/media_assets') && r.method() === 'POST') return json(obj ? { id: 'asset-1' } : [{ id: 'asset-1' }], 201)
    if (u.pathname.startsWith('/functions/v1/')) return json({ ok: true })
    return json(obj ? null : [])
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}

// A real 12-megapixel camera-like JPEG, made in the browser (detail at several scales so it does not shrink unrealistically).
async function bigPhoto() {
  const ctx = await browser.newContext(); const p = await ctx.newPage()
  const b = await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3120; c.height = 4160; const g = c.getContext('2d')
    for (const [cells, alpha] of [[8, 1], [40, 0.5], [200, 0.35], [900, 0.25]]) {
      const s = document.createElement('canvas'); s.width = cells; s.height = Math.round(cells * 4 / 3); const sg = s.getContext('2d'); const d = sg.createImageData(s.width, s.height)
      for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.random() * 255; d.data[i + 1] = Math.random() * 255; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255 }
      sg.putImageData(d, 0, 0); g.globalAlpha = alpha; g.imageSmoothingQuality = 'high'; g.drawImage(s, 0, 0, c.width, c.height)
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85))
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s)
  })
  await ctx.close()
  return Buffer.from(b, 'base64')
}
const webpSize = buf => {                                          // width × height from a WebP header (VP8, VP8L or VP8X)
  const f = buf.toString('ascii', 12, 16)
  if (f === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)]
  if (f === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)] }
  if (f === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff]
  return [0, 0]
}

const photo = await bigPhoto()
console.log(`test photo: 3120×4160 JPEG, ${(photo.length / 1024 / 1024).toFixed(1)} MB`)

// 1. Composer: the original uploads untouched, a ≤1080 px WebP copy uploads alongside, and the gallery row links both.
{
  const t = await open({ url: '/app/create' })
  await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: photo })
  await t.page.waitForFunction(() => document.querySelectorAll('.cp-up.failed').length === 0, null, { timeout: 30000 })
  await t.page.waitForTimeout(4000)
  await t.page.getByRole('button', { name: /^(Post|Share)$/ }).first().click()
  await t.page.waitForTimeout(3000)
  const orig = t.seen.uploads.find(x => x.type === 'image/jpeg')
  const copies = t.seen.uploads.filter(x => x.type === 'image/webp')
  const row = t.seen.post_media[0]?.[0]
  const copy = copies.find(x => x.path === row?.display_path)
  const [w, hgt] = copy ? webpSize(copy.body) : [0, 0]
  check('the original photo uploads untouched (same bytes, own folder)', !!orig && orig.body.equals(photo) && orig.path.startsWith(`${ME}/`), JSON.stringify(t.seen.uploads.map(x => [x.path, x.type, x.body.length])))
  check('a phone-sized WebP copy (1080 px wide, proportions kept) uploads to the member\'s own folder', !!copy && copy.path.startsWith(`${ME}/`) && w === 1080 && hgt === 1440, `${w}×${hgt}`)
  check('the copy is a small fraction of the original', !!copy && copy.body.length < photo.length * 0.25, copy ? `${Math.round(copy.body.length / 1024)} KB vs ${Math.round(photo.length / 1024)} KB` : 'no copy')
  check('the gallery row links the original as the photo and the copy as its display copy', row?.path === orig?.path && row?.display_path === copy?.path && row?.type === 'image', JSON.stringify(t.seen.post_media))
  check('no page errors while posting', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. A server without display copies yet (migration 25 not applied): the post is still saved, the copy is deleted.
{
  const t = await open({ url: '/app/create', noDisplayColumn: true })
  await t.page.locator('input[type=file][multiple]').setInputFiles({ name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: photo })
  await t.page.waitForTimeout(5000)
  await t.page.getByRole('button', { name: /^(Post|Share)$/ }).first().click()
  await t.page.waitForTimeout(3000)
  const copy = t.seen.uploads.find(x => x.type === 'image/webp' && webpSize(x.body)[0] === 1080)
  check('older server: the post is saved without the copy, and the unused copy is deleted', t.seen.post_media.length === 1 && !('display_path' in t.seen.post_media[0][0]) && !!copy && t.seen.deletes.includes(copy.path), JSON.stringify({ pm: t.seen.post_media, del: t.seen.deletes }))
  await t.ctx.close()
}

// 3. Feed: copies by default, originals with High quality; a photo without a copy shows its original.
{
  const t = await open({ url: '/app' })
  await t.page.waitForSelector('.igp-slide img', { timeout: 15000 }); await t.page.waitForTimeout(800)
  check('the feed signs the display copy and never the original of a photo that has one', t.seen.signed.includes(`${OTHER}/big-d.webp`) && !t.seen.signed.includes(`${OTHER}/big.jpg`), JSON.stringify(t.seen.signed))
  check('a photo without a copy (older post) shows its original', t.seen.signed.includes(`${OTHER}/old.jpg`))
  await t.ctx.close()
  const hq = await open({ url: '/app', mode: 'high' })
  await hq.page.waitForSelector('.igp-slide img', { timeout: 15000 }); await hq.page.waitForTimeout(800)
  check('High quality shows photos as uploaded', hq.seen.signed.includes(`${OTHER}/big.jpg`) && !hq.seen.signed.includes(`${OTHER}/big-d.webp`), JSON.stringify(hq.seen.signed))
  await hq.ctx.close()
}

// 4. Profile grid: tiles use the display copy and a video's poster, not the original files.
{
  const t = await open({ url: '/app/u/bob' })
  await t.page.waitForSelector('.shots img', { timeout: 15000 }); await t.page.waitForTimeout(800)
  const videos = await t.page.locator('.shots video').count()
  check('profile grid: photo tiles load the display copy, video tiles their poster (no video element)', t.seen.signed.includes(`${OTHER}/big-d.webp`) && t.seen.signed.includes(`${OTHER}/v-poster.webp`) && !t.seen.signed.includes(`${OTHER}/v.mp4`) && !t.seen.signed.includes(`${OTHER}/big.jpg`) && videos === 0, JSON.stringify({ signed: t.seen.signed, videos }))
  await t.ctx.close()
}

// 5. Field performance numbers.
{
  const t = await open({ url: '/app', sampled: '1' })
  await t.page.waitForSelector('.igp-slide img', { timeout: 15000 }); await t.page.waitForTimeout(1500)
  await t.page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await t.page.waitForTimeout(800)
  const samples = t.seen.metrics.flatMap(m => m.body?.samples ?? [])
  const names = new Set(samples.map(s => s.n))
  const keysOk = samples.every(s => Object.keys(s).sort().join() === 'c,d,m,n,r,v' && typeof s.v === 'number')
  check('a sampled session sends its numbers when the page is hidden (Web Vitals and time to first post)', ['fcp', 'ttfb', 'cls', 'first_post'].every(n => names.has(n)), JSON.stringify([...names]))
  check('each sample is a number plus coarse buckets only (no ids, paths or names)', keysOk && samples.every(s => s.r === 'home' && s.d === 'phone' && s.m === 'auto') && !JSON.stringify(samples).includes('alice') && !JSON.stringify(samples).includes(ME), JSON.stringify(samples.slice(0, 3)))
  check('sent with the member\'s session (the server rate-limits per person)', t.seen.metrics.every(m => m.auth === `Bearer ${token}`))
  await t.ctx.close()
  const n = await open({ url: '/app' })
  await n.page.waitForSelector('.igp-slide img', { timeout: 15000 }); await n.page.waitForTimeout(800)
  await n.page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await n.page.waitForTimeout(500)
  check('sessions not sampled send nothing', n.seen.metrics.length === 0)
  await n.ctx.close()
}

// 6. Admin → Performance.
{
  const t = await open({ url: '/admin/performance', admin: true, width: 1280, height: 900 })
  await t.page.waitForSelector('text=Largest content painted', { timeout: 15000 }).catch(() => {})
  const text = await t.page.locator('main').innerText().catch(() => '')
  check('Admin → Performance shows p50/p75/p95 per metric, screen and data mode', t.seen.summary > 0 && /Largest content painted/.test(text) && text.includes('2.39 s') && text.includes('0.040') && /Reel start-up/.test(text), text.slice(0, 400))
  check('rows with few samples are marked, not extrapolated', /few samples/.test(text))
  await t.ctx.close()
}

await browser.close()
if (failures) { console.log(`round7-check: ${failures} check(s) failed`); process.exit(1) }
console.log('round7-check: all round 7 checks passed')
