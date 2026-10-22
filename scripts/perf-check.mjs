// Lab performance measurement (not a field measurement): loads routes from a local production build against the same
// MOCKED backend used by the other checks, on a phone viewport with throttled CPU (4×) and network (~1.6 Mbps, 150 ms RTT),
// and reports First Contentful Paint, Largest Contentful Paint, Cumulative Layout Shift, JavaScript bytes, request count
// and duplicate requests. Numbers are medians of RUNS cold loads. Use it to compare builds on the same machine only.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const RUNS = Number(process.env.RUNS ?? 3)
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const posts = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, author: OTHER, body: `Post ${i} with some words to read`, media_path: i % 2 ? `${OTHER}/p${i}.png` : null, media_type: i % 2 ? 'image' : null, visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: other, reactions: [{ count: 3 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [], post_media: [], tags: [] }))

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

async function measure(path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.addInitScript(() => {
    window.__cls = 0; window.__lcp = 0
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver(l => { const e = l.getEntries().at(-1); if (e) { window.__lcp = e.startTime; window.__lcpEl = (e.element?.tagName ?? '') + '.' + (e.element?.className ?? '') + ' ' + (e.element?.textContent ?? '').slice(0, 40) } }).observe({ type: 'largest-contentful-paint', buffered: true })
  })
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: '/object/sign/media/x.png?token=t' })
    if (u.pathname.startsWith('/storage/v1/object/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
    if (u.pathname === '/rest/v1/rpc/my_profile') return json(me)
    if (u.pathname === '/rest/v1/profiles') return json(one ? me : [me, other])
    if (u.pathname === '/rest/v1/posts') return json(one ? posts[0] : posts)
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const reqs = []; let js = 0
  page.on("request", r => reqs.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`))
  page.on('response', async r => { if (r.url().endsWith('.js') && r.url().startsWith(BASE)) { try { js += (await r.body()).length } catch { /* ignore */ } } })
  await page.goto(BASE + path, { waitUntil: 'load' })
  await page.waitForTimeout(3500)
  const m = await page.evaluate(() => ({ fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0, lcp: window.__lcp, cls: window.__cls, el: window.__lcpEl }))
  if (process.env.LCP_EL) console.log(`  LCP element: ${m.el}`)
  const counts = new Map(); for (const k of reqs) counts.set(k, (counts.get(k) ?? 0) + 1)
  const dupes = [...counts.values()].filter(n => n > 1).reduce((a, n) => a + n - 1, 0)
  await ctx.close()
  return { ...m, js, requests: reqs.length, dupes }
}

for (const path of (process.env.ROUTES ?? '/app,/app/discover,/app/messages').split(',')) {
  const runs = []; for (let i = 0; i < RUNS; i++) runs.push(await measure(path))
  const pick = k => med(runs.map(r => r[k]))
  console.log(`${path.padEnd(16)} FCP ${Math.round(pick('fcp'))} ms · LCP ${Math.round(pick('lcp'))} ms · CLS ${pick('cls').toFixed(3)} · JS ${(pick('js') / 1024).toFixed(0)} KB · ${pick('requests')} requests (${pick('dupes')} duplicates)`)
}
await browser.close()
