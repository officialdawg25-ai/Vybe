// Lab measurement of feed photo delivery (not field data). A local production build with a mocked API shows Home with six
// photo posts. Photos come from a real local HTTPS server (MEDIA_DIR/cert.pem, key.pem; MEDIA_DIR/photos/photoN.jpg
// originals and photoN-d.webp display copies) so the emulated network applies to them. Each post's gallery row carries
// both paths: a build that knows display copies shows the copy, an older build the original. Per run it records, from
// outside the app, the time from navigation until the first photo is decoded on screen, and the photo bytes the server
// sent once every post has been scrolled past. Cold cache every run. Compare builds only on the same machine.
import { chromium } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:https'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const DIR = process.env.MEDIA_DIR
const RUNS = Number(process.env.RUNS ?? 3)
const MODE = process.env.MODE ?? 'auto'
const NET = { fast: { latency: 40, down: 20e6, up: 5e6 }, '4g': { latency: 80, down: 9e6, up: 2e6 }, slow: { latency: 150, down: 1.6e6, up: 0.75e6 } }[process.env.NET ?? '4g']
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = Date.now()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(now / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(now / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null, onboarded_at: new Date(now).toISOString(), interests: [] }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const files = Object.fromEntries(readdirSync(`${DIR}/photos`).filter(f => /^photo\d+(-d\.webp|\.jpg)$/.test(f)).map(f => [f, readFileSync(`${DIR}/photos/${f}`)]))
const N = Object.keys(files).filter(f => f.endsWith('.jpg')).length
const posts = Array.from({ length: N }, (_, i) => ({
  id: `eeeeeeee-0000-4000-8000-00000000000${i + 1}`, author: OTHER, body: `Photo ${i + 1}`, media_path: `${OTHER}/photo${i + 1}.jpg`, media_type: 'image',
  visibility: 'public', community_id: null, event_id: null, created_at: new Date(now - i * 60e3).toISOString(), edited_at: null, profiles: other,
  reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], tags: [],
  post_media: [{ path: `${OTHER}/photo${i + 1}.jpg`, type: 'image', sort: 0, poster_path: null, display_path: `${OTHER}/photo${i + 1}-d.webp` }],
}))
let sent = 0
const server = createServer({ key: readFileSync(`${DIR}/key.pem`), cert: readFileSync(`${DIR}/cert.pem`) }, (req, res) => {
  const f = Object.keys(files).find(k => req.url.split('?')[0].endsWith('/' + k))
  const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': f?.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end() }
  if (!f) { res.writeHead(404, h); return res.end() }
  sent += files[f].length
  res.writeHead(200, { ...h, 'content-length': files[f].length })
  res.end(files[f])
})
await new Promise(r => server.listen(8443, '127.0.0.1', r))
const med = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-proxy-server', '--host-resolver-rules=MAP mock.supabase.test:443 127.0.0.1:8443'] })
async function run() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, ignoreHTTPSErrors: true })
  await ctx.addInitScript(([s, mode]) => {
    try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s); if (mode !== 'auto') localStorage.setItem('vybe:data-mode', mode) } catch {}
  }, [JSON.stringify(session), MODE])
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range,content-length' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname === '/storage/v1/object/sign/media' && r.method() === 'POST') return json(JSON.parse(r.postData() ?? '{}').paths.map(p => ({ path: p, signedURL: `/object/sign/media/${p}?token=t`, error: null })))
    if (u.pathname.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `${u.pathname.replace('/storage/v1', '')}?token=t` })
    if (Object.keys(files).some(k => u.pathname.endsWith('/' + k))) return route.continue()      // to the real (throttled) server
    if (u.pathname === '/rest/v1/rpc/my_profile') return json(me)
    if (u.pathname === '/rest/v1/profiles') return json(one ? me : [me])
    if (u.pathname === '/rest/v1/posts') return json(!u.searchParams.get('is_reel') && !u.searchParams.has('or') && !u.searchParams.has('created_at') && !u.searchParams.has('author') ? posts : [])
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: NET.latency, downloadThroughput: NET.down / 8, uploadThroughput: NET.up / 8 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  sent = 0
  await page.goto(`${BASE}/app`)
  const first = await page.waitForFunction(() => {
    const img = [...document.querySelectorAll('.igp-slide img')].find(i => i.complete && i.naturalWidth > 0)
    return img ? { t: performance.now(), w: img.naturalWidth, src: img.currentSrc.split('/').pop().split('?')[0] } : null
  }, null, { timeout: 120000, polling: 50 }).then(h => h.jsonValue())
  // Scroll through every post and wait until each photo is decoded.
  for (let k = 0; k < N + 2; k++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(150) }
  await page.waitForFunction(n => [...document.querySelectorAll('.igp-slide img')].filter(i => i.complete && i.naturalWidth > 0).length >= n, N, { timeout: 180000, polling: 200 })
  const total = sent
  await ctx.close()
  return { first: Math.round(first.t), width: first.w, file: first.src, bytes: total }
}
const runs = []
for (let i = 0; i < RUNS; i++) runs.push(await run())
console.log(JSON.stringify({ base: BASE, net: process.env.NET ?? '4g', mode: MODE, runs }))
console.log(`first photo on screen: median ${med(runs.map(r => r.first))} ms (${runs[0].file}, ${runs[0].width} px wide); photo bytes for ${N} posts: median ${(med(runs.map(r => r.bytes)) / 1024).toFixed(0)} KB`)
await browser.close(); server.close()
