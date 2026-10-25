// Group live end to end against a REAL LiveKit server (start one first:
//   livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1          dev keys devkey / secret, ws://127.0.0.1:7880).
// The app runs from a local build with the Supabase API mocked. The token function is replaced by tokens signed here for the
// dev server, with the same grants the Edge Function gives; "bring on stage" / "leave" call LiveKit's RoomService
// UpdateParticipant with the same body the Edge Function sends. Three browsers: host (desktop), viewer A (becomes a guest),
// viewer B (watches). Everything asserted is what each browser actually shows.
import { chromium } from 'playwright'
import { createHmac } from 'node:crypto'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const LK_URL = process.env.LK_URL ?? 'ws://127.0.0.1:7880', LK_HTTP = LK_URL.replace(/^ws/, 'http')
const KEY = 'devkey', SECRET = 'secret'
const HOST = 'aaaaaaaa-0000-4000-8000-000000000001', A = 'cccccccc-0000-4000-8000-000000000003', B = 'dddddddd-0000-4000-8000-000000000004'
const NAMES = { [HOST]: 'Hostess', [A]: 'Amara', [B]: 'Bongi' }
const ROOM = `vybe-group-${Date.now()}`
const now = new Date().toISOString()
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
const jwt = claims => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(claims); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}` }
const t = () => Math.floor(Date.now() / 1000)
const guests = new Set()
const lkToken = (id, publish) => jwt({ iss: KEY, sub: id, name: NAMES[id], nbf: t() - 10, exp: t() + 3600, video: { room: ROOM, roomJoin: true, canSubscribe: true, canPublishData: true, canPublish: publish || guests.has(id), ...(guests.has(id) ? { canPublishSources: ['camera', 'microphone'] } : {}) } })
async function stage(identity, on) {                       // the Edge Function's UpdateParticipant call, verbatim
  const admin = jwt({ iss: KEY, nbf: t() - 10, exp: t() + 60, video: { roomAdmin: true, room: ROOM } })
  const r = await fetch(`${LK_HTTP}/twirp/livekit.RoomService/UpdateParticipant`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ room: ROOM, identity, permission: { can_subscribe: true, can_publish_data: true, can_publish: on, can_publish_sources: on ? ['CAMERA', 'MICROPHONE'] : [] } }) })
  if (!r.ok) throw new Error(`UpdateParticipant ${r.status} ${await r.text()}`)
  if (on) guests.add(identity); else guests.delete(identity)
}
const session = uid => { const tk = `${b64({ alg: 'none' })}.${b64({ sub: uid, aud: 'authenticated', exp: t() + 3600 })}.sig`; return { access_token: tk, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: t() + 3600, user: { id: uid, aud: 'authenticated', email: `${uid.slice(0, 4)}@example.com`, app_metadata: {}, user_metadata: {} } } }
const STREAM = { id: 's1', host: HOST, title: 'Friday group live', status: 'live', access: 'open', event_id: null, started_at: new Date(Date.now() - 65_000).toISOString(), profiles: { username: 'hostess', display_name: 'Hostess', avatar_path: null } }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open(uid, path, viewport) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] })
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s); localStorage.setItem('vybe:live-quality', 'hd') } catch {} }, JSON.stringify(session(uid)))
  await ctx.route('https://mock.supabase.test/**', async route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const one = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname === '/functions/v1/livekit-token') { const b = JSON.parse(r.postData() ?? '{}'); return json({ token: lkToken(uid, Boolean(b.publish)), url: LK_URL, room: ROOM, role: b.publish ? 'host' : guests.has(uid) ? 'guest' : 'viewer', name: NAMES[uid], title: STREAM.title }) }
    if (u.pathname === '/functions/v1/livekit-control') {
      const b = JSON.parse(r.postData() ?? '{}')
      try {
        if (b.action === 'guest_add' && uid === HOST) await stage(b.user_id, true)
        else if (b.action === 'guest_remove' && uid === HOST) await stage(b.user_id, false)
        else if (b.action === 'guest_leave') await stage(uid, false)
        else return json({ error: 'Only the host can do that.' }, 403)
        return json({ ok: true })
      } catch (e) { return json({ error: String(e) }, 500) }
    }
    if (u.pathname === '/rest/v1/live_streams') return json(one ? STREAM : [STREAM])
    if (u.pathname === '/rest/v1/rpc/my_profile' || u.pathname === '/rest/v1/profiles') { const me = { id: uid, username: NAMES[uid].toLowerCase(), display_name: NAMES[uid], avatar_path: null, onboarded_at: now, interests: [] }; return json(one || u.pathname.includes('rpc') ? me : [me]) }
    return json(one ? null : [])
  })
  const page = await ctx.newPage()
  const errs = []; page.on('pageerror', e => errs.push(e.message)); if (process.env.DEBUG) page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[${NAMES[uid]}] ${m.text().slice(0, 300)}`) })
  await page.goto(BASE + path)
  return { page, ctx, errs }
}
const tiles = p => p.locator('.lv-tile').count()
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 300)) } return false }

const host = await open(HOST, '/app/live/s1/host', { width: 1280, height: 800 })
await host.page.waitForTimeout(800)
await host.page.getByRole('button', { name: 'Go live' }).click()
check('host is live (LIVE pill with the running time)', await until(async () => /LIVE \d+:\d\d/.test(await host.page.locator('.lv-pill').textContent() ?? '')), await host.page.locator('.lv-pill').textContent())
const nav = await host.page.evaluate(() => ({ bottom: getComputedStyle(document.querySelector('.bottomnav')).display, covered: document.elementFromPoint(20, 400)?.closest('.lv') != null, top: document.elementFromPoint(640, 2)?.closest('.lv') != null }))
check('the app navigation steps aside: the live screen covers the whole window', nav.bottom === 'none' && nav.covered && nav.top, JSON.stringify(nav))

const a = await open(A, '/app/live/s1', { width: 390, height: 844 })
const b = await open(B, '/app/live/s1', { width: 390, height: 844 })
check('viewers see the host on stage', await until(async () => await a.page.locator('.lv-tile video').count() === 1) && await until(async () => await b.page.locator('.lv-tile video').count() === 1))
check('viewers see Follow, the action rail and a text-only comment box', await a.page.getByRole('button', { name: /^Follow Hostess/ }).isVisible() && await a.page.getByRole('navigation', { name: 'Live actions' }).isVisible() && await a.page.getByRole('textbox', { name: 'Comment' }).isVisible())
const notes = await a.page.locator('.lv').evaluate(el => [...el.querySelectorAll('button')].filter(x => /voice|video note|record/i.test(x.getAttribute('aria-label') ?? '')).length)
check('no voice or video comments on a live (text only)', notes === 0, String(notes))

await a.page.getByRole('textbox', { name: 'Comment' }).fill('Hello from Amara!'); await a.page.getByRole('button', { name: 'Send comment' }).click()
check('a comment reaches the host and the other viewer', await until(async () => await host.page.getByText('Hello from Amara!').count() === 1) && await until(async () => await b.page.getByText('Hello from Amara!').count() === 1))
await host.page.locator('.lv-log li', { hasText: 'Hello from Amara!' }).getByRole('button', { name: 'Pin' }).click()
check('the host pins a comment and every viewer sees it pinned, with the author’s name', await until(async () => await b.page.locator('.lv-pinned', { hasText: 'Amara' }).filter({ hasText: 'Hello from Amara!' }).count() === 1), await b.page.locator('.lv-pinned').textContent().catch(() => ''))

await b.page.getByRole('button', { name: 'More reactions' }).click(); await b.page.getByRole('button', { name: 'Send 🔥' }).click()
check('emoji reactions float up for everyone', await until(async () => (await host.page.locator('.lv-hearts span').allTextContents()).includes('🔥'), 3000))

// Group live: A asks to join, the host brings A on stage.
await a.page.getByRole('button', { name: 'Ask to join the live' }).click()
check('the host is told someone wants to join (badge on Guests)', await until(async () => await host.page.getByRole('button', { name: /Guests: 1 asking to join/ }).count() === 1))
await host.page.getByRole('button', { name: /^Guests/ }).click()
await host.page.getByRole('button', { name: 'Bring on stage' }).click()
check('the guest goes on stage with camera and microphone (permission granted live, no reconnect)', await until(async () => await a.page.locator('.lv-tile').count() === 2 && await a.page.getByRole('button', { name: 'Leave the stage' }).count() === 1, 20000))
check('the host sees a two-person split screen', await until(async () => await tiles(host.page) === 2 && await host.page.locator('.lv-grid.n2 .lv-tile video').count() === 2, 20000), String(await tiles(host.page)))
check('the other viewer sees both people on stage', await until(async () => await b.page.locator('.lv-grid.n2 .lv-tile video').count() === 2, 20000))
check('tiles are labelled with each person’s name', (await b.page.locator('.lv-tile-name').allTextContents()).join('|').includes('Amara'))
await host.page.keyboard.press('Escape')

// Poll.
await host.page.getByRole('button', { name: 'Start a poll' }).click()
await host.page.getByRole('textbox', { name: 'Question' }).fill('Which song next?')
await host.page.getByRole('textbox', { name: 'Answer 1' }).fill('Afro house'); await host.page.getByRole('textbox', { name: 'Answer 2' }).fill('Amapiano')
await host.page.getByRole('button', { name: 'Start poll' }).click()
check('viewers see the live poll', await until(async () => await b.page.locator('.lv-poll', { hasText: 'Which song next?' }).count() === 1))
await b.page.getByRole('button', { name: /Amapiano/ }).click()
check('a vote counts for everyone (one vote, live percentages)', await until(async () => /1 vote/.test(await host.page.locator('.lv-poll-meta').textContent() ?? '') && /100%/.test(await a.page.locator('.lv-poll-opt', { hasText: 'Amapiano' }).textContent() ?? '')))

// Clean view.
await b.page.locator('.lv-grid').click({ position: { x: 150, y: 520 } }); await b.page.waitForTimeout(900)
const cleaned = await b.page.evaluate(() => ({ clean: document.querySelector('.lv')?.classList.contains('clean'), rail: getComputedStyle(document.querySelector('.lv-rail')).opacity }))
check('tapping the video clears the screen (video only)', cleaned.clean && cleaned.rail === '0', JSON.stringify(cleaned))
await b.page.getByRole('button', { name: 'Show controls' }).click()
check('…and the controls come back', !(await b.page.evaluate(() => document.querySelector('.lv')?.classList.contains('clean'))))

// Guest leaves.
await a.page.getByRole('button', { name: 'Leave the stage' }).click()
check('when the guest leaves, the stage goes back to the host alone', await until(async () => await tiles(host.page) === 1 && await tiles(b.page) === 1, 20000))
if (process.env.SHOTS) { await a.page.screenshot({ path: `${process.env.SHOTS}/live-guest.png` }); await b.page.screenshot({ path: `${process.env.SHOTS}/live-viewer.png` }); await host.page.screenshot({ path: `${process.env.SHOTS}/live-host.png` }) }
check('no page errors', !host.errs.length && !a.errs.length && !b.errs.length, [...host.errs, ...a.errs, ...b.errs].join(' | '))

await a.ctx.close(); await b.ctx.close(); await host.ctx.close(); await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall group live checks passed')
process.exit(failures ? 1 : 0)
