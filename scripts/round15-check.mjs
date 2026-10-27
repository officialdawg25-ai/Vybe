// Ticket pass: rotating signed QR (changes every 30 s), official V drawing while valid and flat grey once used, against a MOCKED backend.
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
const EV = 'cccccccc-0000-4000-8000-0000000000c1', T1 = 'dddddddd-0000-4000-8000-0000000000d1', T2 = 'dddddddd-0000-4000-8000-0000000000d2'
const ev = { id: EV, title: 'Neon Nights', starts_at: new Date(Date.now() + 864e5).toISOString(), timezone: 'Africa/Johannesburg', venue: 'The Dome', city: 'Johannesburg' }
const tt = { name: 'VIP', kind: 'vip', tier: 'vip', accent: null, design: 'aurora', perks: [] }
const tickets = [{ id: T1, status: 'valid', transfers: 0, event_id: EV, events: ev, ticket_types: tt }, { id: T2, status: 'used', transfers: 0, event_id: EV, events: ev, ticket_types: tt }]
const w0 = Math.floor(Date.now() / 30000)
const tokens = Array.from({ length: 12 }, (_, i) => ({ w: w0 + i, token: `VYBE2:${T1}:${w0 + i}:${String(i).padStart(20, 'a')}` }))
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } })
await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
await ctx.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
  const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
  const p = u.pathname
  if (p === '/rest/v1/rpc/my_profile') return json(me)
  if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin') return json(false)
  if (p === '/rest/v1/rpc/my_ticket_qr') return json({ tokens, step_seconds: 30, static_ok: true, server_epoch: Math.floor(Date.now() / 1000) })
  if (p === '/rest/v1/rpc/my_ticket_code') return json(null)
  if (p === '/rest/v1/tickets') return json(tickets)
  if (p === '/rest/v1/profiles') return json(obj ? me : [me])
  return json(obj ? null : [])
})
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
await page.goto(BASE + '/app/tickets'); await page.waitForSelector('.pass'); await page.waitForTimeout(600)
await page.getByRole('button', { name: /Show entry QR/ }).first().click()
await page.waitForSelector('svg.bqr', { timeout: 5000 }).catch(async () => { await page.screenshot({ path: '/tmp/claude-0/shots/dbg.png' }) }); await page.waitForTimeout(300)
check('live ticket shows the animated V QR', await page.locator('svg.bqr.live .bqr-v-draw').count() === 1)
const anim = await page.$eval('.bqr-v-draw', e => getComputedStyle(e).animationName)
check('the V is animating while valid', anim === 'bqr-draw', anim)
check('the V uses the official path (not a stroke chevron)', (await page.$eval('.bqr-v-fill', e => e.getAttribute('d') ?? '')).startsWith('M158.2'))
const val = () => page.$eval('svg.bqr', e => e.getAttribute('aria-label'))
check('QR is labelled', (await val()) === 'QR code for your ticket')
check('no static code text is shown', await page.locator('.pass-code').count() === 0)
check('live-code note is shown', await page.getByText(/refreshes every 30 seconds/).count() === 1)
check('a used ticket shows a flat grey V and no animation', await page.locator('.pass-done svg').count() === 1 && await page.locator('.pass-done svg').first().evaluate(e => getComputedStyle(e).fill) !== 'none')
check('the used ticket is greyed', await page.locator('.pass.spent .tk').first().evaluate(e => getComputedStyle(e).filter.includes('grayscale')))
const a = await page.$eval('svg.bqr g', e => e.innerHTML.length)
check('no page errors', errors.length === 0, errors.join(' | '))
await page.evaluate(axe)
const v = (await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 90)}`)
check('axe: no violations', v.length === 0, v.join(' | '))
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/ticket.png` })
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All ticket checks passed')
