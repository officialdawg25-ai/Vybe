// Lab measurement of reel start-up (not field data): a local production build with a mocked API serves real VP9 reels
// (MEDIA_DIR/reel1..3.webm, 1080×1920, ~4 Mbps) with byte-range support, over an emulated network. The videos come from a
// real local HTTPS server (MEDIA_DIR/cert.pem, key.pem) so the emulated network applies to them (mocked responses bypass it). For each run it records,
// from outside the app, the time from a reel becoming current (page load for the first, a swipe for the next ones) to its
// video firing "playing", plus the video bytes downloaded. Cold cache every run. Compare builds only on the same machine.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const DIR = process.env.MEDIA_DIR
const RUNS = Number(process.env.RUNS ?? 3)
const MODE = process.env.MODE ?? 'auto'                          // auto | saver (the app's data mode)
const NET = { fast: { latency: 40, down: 20e6, up: 5e6 }, '4g': { latency: 80, down: 9e6, up: 2e6 }, slow: { latency: 150, down: 1.6e6, up: 0.75e6 } }[process.env.NET ?? '4g']
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null, onboarded_at: now, interests: [] }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const reels = [1, 2, 3].map(i => ({ id: `eeeeeeee-0000-4000-8000-00000000000${i}`, author: OTHER, body: `Reel ${i}`, is_reel: true, media_path: null, media_type: 'video', visibility: 'public', community_id: null, event_id: null, created_at: new Date(Date.now() - i * 60e3).toISOString(), edited_at: null, profiles: other, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], post_media: [{ path: `${OTHER}/reel${i}.webm`, type: 'video', sort: 0, poster_path: null }], tags: [] }))
const files = Object.fromEntries([1, 2, 3].map(i => [`reel${i}.webm`, readFileSync(`${DIR}/reel${i}.webm`)]))
// Real HTTPS server for the video files; Chromium resolves the mock API host to it (the API itself stays mocked in-page).
const server = createServer({ key: readFileSync(`${DIR}/key.pem`), cert: readFileSync(`${DIR}/cert.pem`) }, (req, res) => {
  const f = Object.keys(files).find(k => req.url.split('?')[0].endsWith('/' + k))
  const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range,content-length', 'accept-ranges': 'bytes', 'content-type': 'video/webm' }
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end() }
  if (!f) { res.writeHead(404, h); return res.end() }
  const buf = files[f], m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
  const a = m ? Number(m[1]) : 0, z = m && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1
  res.writeHead(m ? 206 : 200, { ...h, 'content-length': z - a + 1, ...(m ? { 'content-range': `bytes ${a}-${z}/${buf.length}` } : {}) })
  res.end(buf.subarray(a, z + 1))
})
await new Promise(r => server.listen(8443, '127.0.0.1', r))
const med = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--no-proxy-server', '--host-resolver-rules=MAP mock.supabase.test:443 127.0.0.1:8443'] })
async function run() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true })
  await ctx.addInitScript(([s, mode]) => {
    try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s); if (mode !== 'auto') localStorage.setItem('vybe:data-mode', mode) } catch {}
    window.__playing = []
    document.addEventListener('playing', e => { const v = e.target; if (v.classList?.contains('reel-video')) window.__playing.push({ t: performance.now(), src: (v.currentSrc || '').split('/').pop().split('?')[0] }) }, true)
  }, [JSON.stringify(session), MODE])
  const bytes = {}
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range,content-length' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname === '/storage/v1/object/sign/media' && r.method() === 'POST') return json(JSON.parse(r.postData() ?? '{}').paths.map(p => ({ path: p, signedURL: `/object/sign/media/${p}?token=t`, error: null })))
    if (u.pathname.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `${u.pathname.replace('/storage/v1', '')}?token=t` })
    const f = Object.keys(files).find(k => u.pathname.endsWith('/' + k))
    if (f) return route.continue()                                                // to the real (throttled) server
    if (u.pathname === '/rest/v1/rpc/my_profile') return json(me)
    if (u.pathname === '/rest/v1/profiles') return json(one ? me : [me])
    if (u.pathname === '/rest/v1/posts') return json(u.searchParams.get('is_reel') && !u.searchParams.has('or') && !u.searchParams.has('created_at') ? reels : [])
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  // Bytes actually received for each video, from the network layer (a cancelled range request counts only what arrived).
  const reqFile = new Map()
  cdp.on('Network.requestWillBeSent', e => { const f = Object.keys(files).find(k => e.request.url.split('?')[0].endsWith('/' + k)); if (f) reqFile.set(e.requestId, f) })
  cdp.on('Network.dataReceived', e => { const f = reqFile.get(e.requestId); if (f) bytes[f] = (bytes[f] ?? 0) + e.dataLength })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: NET.latency, downloadThroughput: NET.down / 8, uploadThroughput: NET.up / 8 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const t0 = Date.now()
  await page.goto(BASE + '/app/reels')
  await page.waitForFunction(() => window.__playing.length > 0, null, { timeout: 60000 }).catch(async () => console.error('no reel played; page says:', (await page.locator('body').innerText()).slice(-300)))
  const first = await page.evaluate(() => window.__playing[0]?.t ?? null)
  const firstBytes = { ...bytes }
  const swipes = []
  for (const i of [1, 2]) {
    await page.waitForTimeout(3000)                                            // watch a few seconds (next one may load meanwhile)
    const before = await page.evaluate(() => window.__playing.length)
    const tStart = await page.evaluate(i => { const l = document.querySelector('.reels-list'); l.scrollTo({ top: i * l.clientHeight }); return performance.now() }, i)
    await page.waitForFunction(([n, want]) => window.__playing.slice(n).some(p => p.src === want), [before, `reel${i + 1}.webm`], { timeout: 60000 }).catch(() => {})
    const tPlay = await page.evaluate(([n, want]) => window.__playing.slice(n).find(p => p.src === want)?.t ?? null, [before, `reel${i + 1}.webm`])
    swipes.push(tPlay != null ? tPlay - tStart : null)
  }
  const total = Object.values(bytes).reduce((a, b) => a + b, 0)
  await ctx.close()
  return { first, swipes, firstBytes: Object.values(firstBytes).reduce((a, b) => a + b, 0), total, wall: Date.now() - t0 }
}
const results = []; for (let i = 0; i < RUNS; i++) results.push(await run())
await browser.close(); server.close()
const mb = n => (n / 1048576).toFixed(1) + ' MB'
console.log(`${BASE} · mode ${MODE} · network ${process.env.NET ?? '4g'} · ${RUNS} cold runs (medians)`)
console.log(`  first reel: page load → playing  ${Math.round(med(results.map(r => r.first)))} ms`)
console.log(`  next reel:  swipe → playing      ${Math.round(med(results.flatMap(r => r.swipes)))} ms   (each: ${results.flatMap(r => r.swipes).map(x => x == null ? 'never' : Math.round(x)).join(', ')})`)
console.log(`  video downloaded: by first frame ${mb(med(results.map(r => r.firstBytes)))}, over the session ${mb(med(results.map(r => r.total)))}`)
