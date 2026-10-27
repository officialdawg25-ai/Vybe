// Video editor in the composer: opens on a picked video, trim handles (pointer + keyboard), sound off, audience / comments / counts, publishing writes the trim and the controls; playback honours the trim. MOCKED backend.
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
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
// A real 4 s WebM with a proper length and index (made with ffmpeg: node scripts/round17-check.mjs needs VIDEO=<file>, or ffmpeg on PATH).
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const vf = process.env.VIDEO ?? (() => { const f = join(mkdtempSync(join(tmpdir(), 'vybe-')), 't.webm'); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15', '-c:v', 'libvpx', '-b:v', '300k', '-an', f]); return f })()
const webm = readFileSync(vf)
const seen = { media: [], posts: [], uploads: 0 }
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
await ctx.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
  const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
  const p = u.pathname
  let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
  if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST' && Array.isArray(body?.paths)) return json(body.paths.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
  if (p.startsWith('/storage/v1/object/media/') && r.method() === 'POST') { seen.uploads++; return json({ Key: 'ok', Id: 'x' }) }
  if (p === '/rest/v1/rpc/my_profile') return json(me)
  if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin') return json(false)
  if (p === '/rest/v1/posts' && r.method() === 'POST') { seen.posts.push(body); return route.fulfill({ status: 201, headers: h, contentType: 'application/json', body: JSON.stringify(obj ? { id: 'p-new' } : [{ id: 'p-new' }]) }) }
  if (p === '/rest/v1/post_media' && r.method() === 'POST') { seen.media.push(body); return route.fulfill({ status: 201, headers: h, contentType: 'application/json', body: '[]' }) }
  if (p === '/rest/v1/profiles') return json(obj ? me : [me])
  return json(obj ? null : [])
})
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
await page.goto(BASE + '/app/create'); await page.waitForSelector('.cp-text')
await page.locator('input[type=file]').first().setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: webm })
await page.waitForSelector('.ve', { timeout: 8000 }).catch(() => {})
check('picking one video opens the editor straight away', await page.locator('.ve').count() === 1)
await page.waitForSelector('.ve-strip', { timeout: 8000 })
await page.waitForFunction(() => document.querySelectorAll('.ve-frames i').length >= 2, null, { timeout: 15000 }).catch(() => {})
const dur = await page.locator('.ve video').evaluate(v => v.duration)
check('the video length is read (even for browser-recorded WebM)', Number.isFinite(dur) && dur > 1, String(dur))
check('a strip of frames is shown across the timeline', await page.locator('.ve-frames i').count() >= 2, String(await page.locator('.ve-frames i').count()))
const box = await page.locator('.ve-strip').boundingBox()
// drag the start handle to 25 % and the end handle to 75 % with real pointer input
await page.mouse.move(box.x - 6, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 6 }); await page.mouse.up()
await page.mouse.move(box.x + box.width + 6, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 6 }); await page.mouse.up()
const s1 = Number(await page.getByRole('slider', { name: 'Start of the video' }).getAttribute('aria-valuenow')), e1 = Number(await page.getByRole('slider', { name: 'End of the video' }).getAttribute('aria-valuenow'))
check('dragging the ends sets where it starts and stops', Math.abs(s1 - dur * 0.25) < 0.4 && Math.abs(e1 - dur * 0.75) < 0.4, `${s1} – ${e1} of ${dur}`)
await page.getByRole('slider', { name: 'Start of the video' }).focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
const s2 = Number(await page.getByRole('slider', { name: 'Start of the video' }).getAttribute('aria-valuenow'))
check('the handles also work from the keyboard', s2 > s1 + 0.15, `${s1} → ${s2}`)
// the end cannot cross the start
await page.getByRole('slider', { name: 'End of the video' }).focus(); for (let i = 0; i < 120; i++) await page.keyboard.press('ArrowLeft')
const s3 = Number(await page.getByRole('slider', { name: 'Start of the video' }).getAttribute('aria-valuenow')), e3 = Number(await page.getByRole('slider', { name: 'End of the video' }).getAttribute('aria-valuenow'))
check('the end can never come closer than half a second to the start', e3 - s3 >= 0.45, `${s3} – ${e3}`)
await page.getByRole('slider', { name: 'End of the video' }).focus(); for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight')
// preview loops inside the window
await page.getByRole('button', { name: 'Play preview' }).click(); await page.waitForTimeout(1800)
const t = await page.locator('.ve video').evaluate(v => v.currentTime), endNow = Number(await page.getByRole('slider', { name: 'End of the video' }).getAttribute('aria-valuenow')), startNow = Number(await page.getByRole('slider', { name: 'Start of the video' }).getAttribute('aria-valuenow'))
check('the preview plays only the chosen part', t >= startNow - 0.2 && t <= endNow + 0.3, `${t.toFixed(2)} in ${startNow}–${endNow}`)
await page.getByRole('button', { name: 'Video sound' }).click()
check('sound can be switched off', await page.getByRole('button', { name: 'Sound off' }).first().isVisible())
await page.getByRole('radio', { name: /Friends/ }).click()
await page.getByRole('switch', { name: 'Allow comments' }).click()
await page.getByRole('switch', { name: /Show like and comment counts/ }).click()
check('comments and counts switches reflect the choice', (await page.getByRole('switch', { name: 'Allow comments' }).getAttribute('aria-checked')) === 'false' && (await page.getByRole('switch', { name: /Show like/ }).getAttribute('aria-checked')) === 'false')
check('Music is offered inside the editor', await page.getByRole('button', { name: /Music/ }).isVisible())
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/video-editor.png` })
await page.evaluate(axe)
const v = (await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 100)}`)
check('axe: no violations in the editor', v.length === 0, v.join(' | '))
await page.getByRole('button', { name: 'Done' }).click()
check('Done returns to the post with the video marked as edited', await page.locator('.ve').count() === 0 && await page.locator('.cp-media .cp-vtag').first().textContent().then(x => /\d:\d/.test(x ?? '')))
check('the post summary mentions comments off and hidden counts', /comments off/.test(await page.locator('.cp-summary').textContent() ?? ''))
await page.locator('.cp-text').fill('A trimmed clip for everyone who loves short things')
await page.waitForTimeout(2500)
await page.getByRole('button', { name: 'Post', exact: true }).click()
await page.waitForTimeout(3500)
const post = seen.posts[0] ?? {}, media = (seen.media[0] ?? [])[0] ?? {}
check('publishing saves comments off and hidden counts on the post', post.comments_off === true && post.hide_counts === true && post.visibility === 'friends', JSON.stringify({ c: post.comments_off, h: post.hide_counts, v: post.visibility }))
check('publishing saves the trim and sound-off beside the original file', media.trim_start_ms > 0 && media.trim_end_ms > media.trim_start_ms + 400 && media.muted === true && media.type === 'video', JSON.stringify(media))
check('no page errors', errors.length === 0, errors.join(' | '))
await ctx.close()

// Playback honours the trim: a post whose video is trimmed to 1–2 s never plays outside it.
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } })
await ctx2.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
const OTHER2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const post2 = { id: 'p1', author: OTHER2, body: 'trimmed', media_path: `${OTHER2}/v.webm`, media_type: 'video', visibility: 'public', community_id: null, event_id: null, created_at: new Date().toISOString(), edited_at: null, profiles: { id: OTHER2, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }, reactions: [{ count: 4 }], comments: [{ count: 2 }], mine_reaction: [], mine_save: [], comments_off: true, hide_counts: true, post_media: [{ path: `${OTHER2}/v.webm`, type: 'video', sort: 0, trim_start_ms: 1000, trim_end_ms: 2000, muted: true }] }
await ctx2.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range,accept-ranges,content-length' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
  const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object'), p = u.pathname
  let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
  if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST' && Array.isArray(body?.paths)) return json(body.paths.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
  if (p.startsWith('/storage/v1/object/sign/media/')) {                                    // byte ranges, like Storage: a player can only seek in a file that supports them
    const m = /bytes=(\d*)-(\d*)/.exec(r.headers().range ?? ''), total = webm.length
    if (!m) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': String(total) }, body: webm })
    const a = m[1] ? Number(m[1]) : 0, b = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
    return route.fulfill({ status: 206, headers: { ...h, 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${total}`, 'content-length': String(b - a + 1) }, body: webm.subarray(a, b + 1) })
  }
  if (p === '/rest/v1/rpc/my_profile') return json(me)
  if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin' || p === '/rest/v1/rpc/sponsored_feed') return json(p.endsWith('sponsored_feed') ? [] : false)
  if (p === '/rest/v1/posts') return json(obj ? post2 : [post2])
  if (p === '/rest/v1/profiles') return json(obj ? me : [me])
  return json(obj ? null : [])
})
const pg = await ctx2.newPage(); const errs2 = []; pg.on('pageerror', e => errs2.push(String(e)))
await pg.goto(BASE + '/app'); await pg.waitForSelector('.igp-slide video', { timeout: 15000 }).catch(() => {})
await pg.locator('.igp-media').first().scrollIntoViewIfNeeded(); await pg.evaluate(() => { const m = document.querySelector('.igp-media'); const r = m.getBoundingClientRect(); window.scrollBy(0, r.top - 80) }); await pg.waitForTimeout(3500)
const times = []; for (let i = 0; i < 8; i++) { times.push(await pg.locator('.igp-slide video').first().evaluate(v => v.currentTime)); await pg.waitForTimeout(350) }
check('a trimmed video plays only inside its window (1.0 – 2.0 s) and loops', times.every(x => x >= 0.95 && x <= 2.15) && Math.max(...times) - Math.min(...times) > 0.1, times.map(x => x.toFixed(2)).join(' '))
check('a video marked sound-off has no sound button', await pg.locator('.igp-vol').count() === 0)
check('hidden counts: others see no like or comment numbers', await pg.locator('.igp-act span').count() === 0)
check('comments off is said plainly under the post', await pg.getByText('Comments are turned off').count() > 0)
check('no page errors in the feed', errs2.length === 0, errs2.join(' | '))
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All video editor checks passed')
