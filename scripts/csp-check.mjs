// Loads key screens with the production Content-Security-Policy (from public/_headers) enforced and fails on any violation.
// Uses the same mocked backend as the other checks, so the mock host is added to connect-src for the test only.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
const csp = headers.match(/Content-Security-Policy: (.*)/)[1].replace('https://*.supabase.co', 'https://*.supabase.co https://mock.supabase.test').replace('wss://*.supabase.co', 'wss://*.supabase.co wss://mock.supabase.test')
const ME = 'aaaaaaaa-0000-4000-8000-000000000001'
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
let failures = 0
for (const path of ['/', '/signin', '/app', '/app/discover', '/app/messages', '/app/settings/chat-security', '/app/plans?new=1']) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 780 }, permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', r => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, contentType: 'application/json', body: r.request().method() === 'OPTIONS' ? '' : '[]' }))
  // Serve the app's own files with the production policy attached to the HTML document.
  await ctx.route(`${BASE}/**`, async route => {
    const res = await route.fetch()
    const h = { ...res.headers() }
    if ((h['content-type'] ?? '').includes('text/html')) h['content-security-policy'] = csp
    await route.fulfill({ response: res, headers: h })
  })
  const page = await ctx.newPage(), violations = []
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 220)) })
  page.on('pageerror', e => { if (/Content Security Policy/i.test(e.message)) violations.push(e.message.slice(0, 220)) })
  await page.goto(BASE + path); await page.waitForTimeout(1200)
  const rendered = (await page.locator('body').innerText()).trim().length > 20
  const ok = violations.length === 0 && rendered
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} CSP ${path}${violations.length ? ' — ' + violations.join(' | ') : rendered ? '' : ' — page did not render'}`)
  await ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} CSP check(s) failed` : '\nthe production Content-Security-Policy blocks nothing the app needs')
process.exit(failures ? 1 : 0)
