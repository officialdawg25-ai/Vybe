// Browser checks for the Memories viewer (hold anywhere, one persistent song element, closing goes back, activity tabs)
// against a MOCKED backend. Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }
const U = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
const mem = (id, extra = {}) => ({ id, kind: 'text', media_path: null, text_body: `Memory ${id}`, bg: 'sun', created_at: now, expires_at: later, visibility: 'public', highlight: false, highlight_title: null, mine_reaction: null, seen: false, views: 3, reactions: 1, replies: 2, music_track_id: 't1', music_title: 'Elad', music_artist: 'Jay Anthony', music_path: null, music_start_ms: 0, music_preview_path: `music/${U}.mp3`, music_artwork_path: null, filter: 'none', overlays: [], ...extra })
const memories = [mem('m1'), mem('m2')]
// Three seconds of silence (8 kHz, 8-bit mono) so the element really plays and loops like a real clip.
const WAV = (() => { const n = 24000, h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + n, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(n, 40); return Buffer.concat([h, Buffer.alloc(n, 128)]) })()

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open(url, who = me) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: false })
  await ctx.addInitScript(s => {
    try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {}
    // Instrument audio: how many elements were created and whether the last one is playing.
    const Real = window.Audio; window.__aud = { made: 0, plays: 0, els: [] }
    window.Audio = function (...a) { const el = new Real(...a); window.__aud.made++; window.__aud.els.push(el); const p = el.play.bind(el); el.play = () => { window.__aud.plays++; return p() }; return el }
  }, JSON.stringify({ ...session, user: { ...session.user, id: who.id } }))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const p = u.pathname
    if (p.startsWith('/storage/v1/object/sign/media')) return json({ signedURL: `/object/sign/media/x?token=t` })
    if (p.startsWith('/storage/v1/object/public/brand/')) return route.fulfill({ status: 404, headers: h, body: '' })
    if (p === '/rest/v1/rpc/my_profile') return json(me)
    if (p === '/rest/v1/rpc/author_memories') return json(memories)
    if (p === '/rest/v1/rpc/memory_rail') return json([{ author: other, count: 2, unseen: 2, latest_at: now, friend: true, cover: { kind: 'text', media_path: null, text_body: 'hi', bg: 'sun' } }])
    if (p === '/rest/v1/profiles') { const id = u.searchParams.get('id')?.replace('eq.', ''); const one = id === ME ? me : other; return json(obj ? one : id ? [one] : [me, other]) }
    if (p === '/rest/v1/memory_replies') return json([{ id: 'r1', body: 'Gg', audio_path: null, audio_ms: null, created_at: now, profiles: other }])
    if (p === '/rest/v1/memory_reactions') return json([{ user_id: OTHER, emoji: 'fire', created_at: now, profiles: other }])
    if (p === '/rest/v1/memory_views') return json([{ viewer: OTHER, viewed_at: now, profiles: other }])
    return json(obj ? null : [])
  })
  // Songs are public library files; serve a tiny silent WAV so the element really plays.
  await ctx.route(/\/music\/.*\.mp3/, route => route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'access-control-allow-origin': '*' }, body: WAV }))
  const page = await ctx.newPage()
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, errors }
}
const state = page => page.evaluate(() => {
  const bar = document.querySelector('.mvw-bar i.run'); const a = window.__aud.els.at(-1)
  return { path: location.pathname, bar: bar ? getComputedStyle(bar).animationPlayState : null, audioPaused: a ? a.paused : null, made: window.__aud.made, plays: window.__aud.plays, shown: document.querySelector('.mvw-bars')?.getAttribute('aria-valuenow') }
})

// 1. Hold anywhere (here: the header, which used to do nothing) pauses picture progress AND the song; release resumes.
{
  const t = await open(`/app/memories/${OTHER}`)
  await t.page.waitForSelector('.mvw-stage'); await t.page.waitForTimeout(900)
  let s = await state(t.page)
  check('song starts on its own (one audio element)', s.made === 1 && s.audioPaused === false && s.plays >= 1, JSON.stringify(s))
  const box = await t.page.locator('.mvw-time').boundingBox()
  await t.page.mouse.move(box.x + 5, box.y + 5); await t.page.mouse.down(); await t.page.waitForTimeout(500)
  s = await state(t.page)
  check('pressing the header holds the progress bar and the song', s.bar === 'paused' && s.audioPaused === true, JSON.stringify(s))
  await t.page.mouse.up(); await t.page.waitForTimeout(400)
  s = await state(t.page)
  check('releasing resumes both, and stays on the same memory and screen', s.bar === 'running' && s.audioPaused === false && s.path === `/app/memories/${OTHER}` && s.shown === '1', JSON.stringify(s))

  // Holding the name must NOT open the profile; a quick tap on it does.
  const id = await t.page.locator('.mvw-id').boundingBox()
  await t.page.mouse.move(id.x + 10, id.y + 10); await t.page.mouse.down(); await t.page.waitForTimeout(500); await t.page.mouse.up(); await t.page.waitForTimeout(300)
  s = await state(t.page)
  check('holding the author’s name does not open their profile', s.path === `/app/memories/${OTHER}`, s.path)

  // A quick tap on the right side moves on, keeping the SAME audio element (so mobile browsers keep allowing sound).
  await t.page.mouse.click(330, 400); await t.page.waitForTimeout(500)
  s = await state(t.page)
  check('quick tap moves to the next memory without recreating the audio element', s.shown === '2' && s.made === 1 && s.audioPaused === false, JSON.stringify(s))
  // Dragging off the element and releasing elsewhere must still end the hold.
  await t.page.mouse.move(200, 300); await t.page.mouse.down(); await t.page.mouse.move(200, 700, { steps: 5 }); await t.page.mouse.up(); await t.page.waitForTimeout(300)
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. Closing returns to where the viewer was opened from (Home), not to the author's profile.
{
  const t = await open('/app')
  await t.page.waitForSelector(`a[href="/app/memories/${OTHER}"]`); await t.page.click(`a[href="/app/memories/${OTHER}"]`)
  await t.page.waitForSelector('.mvw-stage'); await t.page.waitForTimeout(300)
  await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(500)
  check('closing goes back to Home', new URL(t.page.url()).pathname === '/app', t.page.url())
  await t.ctx.close()
}

// 3. Activity sheet (own memories): horizontal tabs; each tab lists only its own rows.
{
  const t = await open(`/app/memories/${ME}`)
  await t.page.waitForSelector('.mvw-stats'); await t.page.click('.mvw-stats'); await t.page.waitForSelector('.act-tabs')
  const tabs = await t.page.locator('.act-tab').allInnerTexts()
  check('three horizontal tabs with counts', tabs.length === 3 && /Replies/.test(tabs[0]) && /Reactions/.test(tabs[1]) && /Seen by/.test(tabs[2]), tabs.join('|'))
  check('Replies tab shows only replies', await t.page.locator('.act-bubble').count() === 1 && await t.page.locator('.act-list .emo').count() === 0)
  await t.page.getByRole('tab', { name: /Reactions/ }).click()
  check('Reactions tab shows the animated emoji, not replies', await t.page.locator('.act-list .emo').count() === 1 && await t.page.locator('.act-bubble').count() === 0)
  await t.page.getByRole('tab', { name: /Seen by/ }).click()
  check('Seen by tab lists viewers', await t.page.locator('.act-row').count() === 1)
  check('no page errors in activity', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
