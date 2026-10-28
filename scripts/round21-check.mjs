// Song moment picker in WhatsApp layout (screenshot + basic checks). MOCKED backend.
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
const gen = await browser.newPage()
const wav = Buffer.from(await gen.evaluate(() => { const sr = 8000, n = sr * 75, b = new ArrayBuffer(44 + n * 2), v = new DataView(b); const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0))); w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true); for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 3000, true); let s = ''; new Uint8Array(b).forEach(x => (s += String.fromCharCode(x))); return btoa(s) }), 'base64')
await gen.close()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
await ctx.route('https://mock.supabase.test/**', route => {
  const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
  if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
  const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
  const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object'), p = u.pathname
  if (p.startsWith('/storage/v1/object/public/brand/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'audio/wav' }, body: wav })
  if (p === '/rest/v1/rpc/my_profile') return json(me)
  if (p === '/rest/v1/rpc/music_catalog') return json([{ id: 't1', title: 'Nobody', artist: 'Some Artist', genre: null, preview_path: 'music/nobody.wav', artwork_path: null, duration_ms: 75000, external_url: null, saved: false }])
  if (p === '/rest/v1/profiles') return json(obj ? me : [me])
  return json(obj ? null : [])
})
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
await page.goto(BASE + '/app/create'); await page.waitForSelector('.cp-text')
await page.getByRole('button', { name: /Music/ }).first().click(); await page.waitForTimeout(800)
await page.getByRole('button', { name: /Use Nobody/ }).click(); await page.waitForTimeout(1500)
check('WhatsApp layout: close, artwork and Done on top', await page.locator('.ms-wa-top .ms-wa-done').isVisible() && await page.getByRole('button', { name: 'Back to songs' }).isVisible())
check('a play/pause button, the line with the chosen stretch, and the total length', await page.getByRole('button', { name: /Pause the song|Play the song/ }).isVisible() && await page.locator('.ms-wa-seg').count() === 1 && (await page.locator('.ms-wa-total').textContent()) === '1:15')
check('the length of the clip above the waveform window', /^\d+s$/.test(await page.locator('.ms-wa-len').textContent() ?? ''))
check('no page errors', errors.length === 0, errors.join(' | '))
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/music-clip.png` })
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All song picker checks passed')
