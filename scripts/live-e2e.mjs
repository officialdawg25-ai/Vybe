// End-to-end live video check against a REAL LiveKit server (not a mock): start one locally first, e.g.
//   livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1      (dev keys: devkey / secret, ws://127.0.0.1:7880)
// The VYBE app runs from a local build with the Supabase API mocked; only the token function is replaced by a locally
// signed token for that dev server. Chromium's fake camera publishes; two viewers (a desktop-size and a phone-size screen)
// subscribe. Everything reported is read from WebRTC statistics in the page (the app's own Stream quality panel), i.e.
// what was actually captured, encoded and received on this machine over loopback — not a real mobile network.
import { chromium } from 'playwright'
import { createHmac } from 'node:crypto'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const LK_URL = process.env.LK_URL ?? 'ws://127.0.0.1:7880'
const KEY = process.env.LK_KEY ?? 'devkey', SECRET = process.env.LK_SECRET ?? 'secret'
const QUALITY = process.env.QUALITY ?? '1080p'
const HOST = 'aaaaaaaa-0000-4000-8000-000000000001', VIEWER = 'cccccccc-0000-4000-8000-000000000003'
const ROOM = `vybe-e2e-${Date.now()}`
const now = new Date().toISOString()
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
const jwt = claims => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(claims); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}` }
const lkToken = (identity, publish) => jwt({ iss: KEY, sub: identity, name: identity === HOST ? 'Host' : 'Viewer', nbf: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 3600, video: { room: ROOM, roomJoin: true, canSubscribe: true, canPublish: publish, canPublishData: true } })
const session = uid => { const t = `${b64({ alg: 'none' })}.${b64({ sub: uid, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`; return { access_token: t, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, aud: 'authenticated', email: `${uid.slice(0, 4)}@example.com`, app_metadata: {}, user_metadata: {} } } }
const STREAM = { id: 's1', host: HOST, title: 'E2E quality test', status: 'live', access: 'open', event_id: null, profiles: { username: 'host', display_name: 'Host', avatar_path: null } }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open(uid, path, viewport, conditions = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(([s, c]) => {
    try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {}
    // Present the host as a capable laptop so "Auto" may choose Full HD (the choice logic itself is unit-tested).
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => c.cores ?? 8 }); Object.defineProperty(navigator, 'deviceMemory', { get: () => c.mem ?? 8 })
  }, [JSON.stringify(session(uid)), conditions])
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname === '/functions/v1/livekit-token') { const b = JSON.parse(r.postData() ?? '{}'); return json({ token: lkToken(uid, Boolean(b.publish)), url: LK_URL, room: ROOM, role: b.publish ? 'host' : 'viewer', name: 'x', title: STREAM.title }) }
    if (u.pathname === '/rest/v1/live_streams') return json(one ? STREAM : [STREAM])
    if (u.pathname === '/rest/v1/rpc/my_profile' || u.pathname === '/rest/v1/profiles') { const me = { id: uid, username: uid === HOST ? 'host' : 'viewer', display_name: uid === HOST ? 'Host' : 'Viewer', avatar_path: null, onboarded_at: now, interests: [] }; return json(one || u.pathname.includes('rpc') ? me : [me]) }
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + path)
  return { page, ctx, errs }
}
const stats = async page => {
  if (!(await page.locator('.lv-stats').count())) { await page.getByRole('button', { name: 'Stream quality' }).click(); }
  await page.waitForTimeout(4500)                                  // two samples, so rates are real
  const rows = await page.locator('.lv-stats > div').evaluateAll(ds => Object.fromEntries(ds.map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])))
  await page.keyboard.press('Escape'); await page.waitForTimeout(200)
  return rows
}
const px = s => { const m = /(\d+) × (\d+)/.exec(s ?? ''); return m ? { w: +m[1], h: +m[2] } : null }

// Host goes live at the chosen quality.
const host = await open(HOST, '/app/live/s1/host', { width: 1280, height: 800 })
await host.page.waitForTimeout(1200)
await host.page.getByRole('radio', { name: QUALITY, exact: true }).click()
await host.page.getByRole('button', { name: 'Go live' }).click()
await host.page.getByText('You’re live').waitFor({ timeout: 20000 })
check('host connected to the LiveKit server and published', true)

const big = await open(VIEWER, '/app/live/s1', { width: 1920, height: 1080 })
await big.page.locator('video.live-video').first().waitFor({ timeout: 20000 })
await big.page.waitForTimeout(6000)                                 // let the top simulcast layer ramp up
const phone = await open(VIEWER.replace('ccc', 'ddd'), '/app/live/s1', { width: 390, height: 844 })
await phone.page.locator('video.live-video').first().waitFor({ timeout: 20000 })
await phone.page.waitForTimeout(6000)

// Bandwidth estimation starts low and the encoder adds layers as it ramps up: follow the desktop viewer for up to RAMP_S.
const RAMP_S = Number(process.env.RAMP_S ?? 30)
const ramp = []
await big.page.getByRole('button', { name: 'Stream quality' }).click()
for (let t = 0; t < RAMP_S; t += 3) {
  await big.page.waitForTimeout(3000)
  const recv = await big.page.locator('.lv-stats > div', { hasText: 'Receiving' }).locator('dd').textContent()
  ramp.push(`${t + 3}s: ${recv}`)
  if (/1080 × 1920|1920 × 1080/.test(recv ?? '')) break
}
await big.page.keyboard.press('Escape'); await big.page.waitForTimeout(200)
console.log('Desktop viewer over time:\n  ' + ramp.join('\n  '))
console.log('Desktop viewer video element (CSS px × device pixel ratio):', await big.page.evaluate(() => { const v = document.querySelector('video.live-video'); const r = v.getBoundingClientRect(); return `${Math.round(r.width)} × ${Math.round(r.height)} @${devicePixelRatio}, stream ${v.videoWidth} × ${v.videoHeight}` }))
const h = await stats(host.page), b = await stats(big.page), p = await stats(phone.page)
console.log('\nHOST', JSON.stringify(h, null, 1), '\nDESKTOP VIEWER', JSON.stringify(b, null, 1), '\nPHONE VIEWER', JSON.stringify(p, null, 1), '\n')
const cam = px(h.Camera), sending = Object.entries(h).filter(([k]) => k.startsWith('Sending')).map(([k, v]) => ({ k, ...px(v) }))
const recvBig = px(b.Receiving), recvPhone = px(p.Receiving)
check(`host requested ${QUALITY} and the camera delivered a measured size`, Boolean(cam), h.Camera)
check('host sends more than one simulcast layer (a top layer plus smaller ones)', sending.length >= 2, sending.map(s => `${s.k}=${s.w}x${s.h}`).join(', '))
check('the desktop viewer receives a measured video size', Boolean(recvBig), b.Receiving)
check('the phone viewer receives a measured video size', Boolean(recvPhone), p.Receiving)
check('the desktop viewer filling a 1920 × 1080 screen receives the 1080p layer', recvBig && Math.min(recvBig.w, recvBig.h) >= 1080, b.Receiving)
check('the phone-size screen is not sent more than it can show (≤ 720p)', recvPhone && Math.min(recvPhone.w, recvPhone.h) <= 720, p.Receiving)
check('time to first video is measured for viewers', /s after connecting/.test(b['First video'] ?? ''), b['First video'])
check('no page errors', !host.errs.length && !big.errs.length && !phone.errs.length, [...host.errs, ...big.errs, ...phone.errs].join(' | '))

await phone.ctx.close(); await big.ctx.close(); await host.ctx.close(); await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall live end-to-end checks passed')
process.exit(failures ? 1 : 0)
