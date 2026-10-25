// Browser checks for the memory studio, the reel camera/editor, the upgraded reels viewer and Discover music, against a
// MOCKED backend (behaviour and the exact rows sent, not the real database). Uses Chromium's fake camera.
// Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174).
// SHOTS=<dir> also saves a screenshot of each screen.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const SHOTS = process.env.SHOTS
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const U = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b'
const tracks = [
  { id: 't1', title: 'Elad', artist: 'Jay Anthony', artwork_path: null, preview_path: `music/${U}.mp3`, external_url: null, saved: false, duration_ms: 198000, genre: 'RF' },
  { id: 't2', title: 'The Chase Begins', artist: 'Daria Novo', artwork_path: null, preview_path: null, external_url: 'https://example.com', saved: true, duration_ms: 224000, genre: null },
  { id: 't3', title: 'Slick', artist: 'LAVLO', artwork_path: null, preview_path: null, external_url: null, saved: false, duration_ms: 53000, genre: 'RF' },
]
const artists = [{ id: 'o1', name: 'Hugel', slug: 'hugel', kind: 'artist', description: '', avatar_path: null, verified: true, followers: 1280, upcoming: 3, following: false }, { id: 'o2', name: 'Bongeziwe Mabandla', slug: 'bongeziwe', kind: 'artist', description: '', avatar_path: null, verified: false, followers: 312, upcoming: 1, following: true }]
const concert = { id: 'e1', title: 'HUGEL Live', starts_at: '2026-10-30T19:00:00Z', ends_at: null, timezone: 'America/New_York', city: 'Saint Petersburg', venue: 'St. Pete Pier', location: null, cover_path: null, category: 'concerts', category_label: 'Concerts', format: 'in_person', lat: 0, lng: 0, distance_km: 13360, source: 'vybe', source_name: null, price_from_cents: null, price_cents: null, currency: null, has_tickets: false, going: 12, friends_going: 0, friend_avatars: [], followed: false, live: false, artists: ['HUGEL'], host: null, org: { id: 'o1', name: 'Hugel', slug: 'hugel', verified: true } }
const reel = { id: 'r1', author: OTHER, body: 'Golden hour run', media_path: `${OTHER}/r.mp4`, media_type: 'video', visibility: 'public', is_reel: true, created_at: now, profiles: other, reactions: [{ count: 4 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [], tags: [], post_media: [{ path: `${OTHER}/r.mp4`, type: 'video', sort: 0, poster_path: null }], music_track_id: 't1', music_title: 'Elad', music_artist: 'Jay Anthony', track: { preview_path: `music/${U}.mp3`, artwork_path: null }, reel_edit: { filter: 'warm', speed: 2, ms: 12000, mv: 1 } }
const studioMemory = { id: 'm1', kind: 'text', media_path: null, text_body: 'We graduated!', bg: 'sun', created_at: now, expires_at: now, visibility: 'close_friends', highlight: false, highlight_title: null, mine_reaction: null, seen: false, views: null, reactions: null, replies: null, music_track_id: 't1', music_title: 'Elad', music_artist: 'Jay Anthony', music_path: null, music_start_ms: 30000, music_preview_path: `music/${U}.mp3`, music_artwork_path: null, filter: 'none', overlays: [{ t: 'sticker', id: 'a', emoji: '🎓', x: 0.5, y: 0.25, size: 1.4 }, { t: 'mention', id: 'b', uid: ME, username: 'alice', x: 0.5, y: 0.72, size: 1 }, { t: 'draw', id: 'c', color: '#ffd60a', width: 8, pts: [200, 800, 400, 760, 600, 820, 800, 780] }] }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

async function open(url, { width = 390, height = 844, scheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, permissions: ['camera', 'microphone'] })
  const seen = { memories: [], posts: [], uploads: [], close: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    const p = u.pathname
    if (p === '/storage/v1/object/sign/media' && r.method() === 'POST') { const ps = body()?.paths ?? []; return json(ps.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null }))) }
    if (p.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `/object/sign/media/${decodeURIComponent(p.split('/media/')[1])}?token=t` })
    if (p.startsWith('/storage/v1/object/sign/media/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
    if (p.startsWith('/storage/v1/object/media/') && r.method() === 'POST') { seen.uploads.push({ path: decodeURIComponent(p.replace('/storage/v1/object/media/', '')), type: r.headers()['content-type'] ?? '' }); return json({ Key: 'ok' }) }
    if (p.startsWith('/storage/v1/object/public/brand/')) return route.fulfill({ status: 404, headers: h, body: '' })
    if (p === '/rest/v1/rpc/my_profile') return json(me)
    if (p === '/rest/v1/rpc/my_roles' || p === '/rest/v1/rpc/is_admin') return json(false)
    if (p === '/rest/v1/rpc/music_catalog') { const tab = body()?.p_tab; return json(tab === 'saved' ? tracks.filter(t => t.saved) : tracks) }
    if (p === '/rest/v1/rpc/discover_orgs') return json(artists)
    if (p === '/rest/v1/rpc/discover_events') return json([concert])
    if (p === '/rest/v1/rpc/author_memories') return json([studioMemory])
    if (p === '/rest/v1/rpc/memory_rail') return json([])
    if (p === '/rest/v1/close_friends') { if (r.method() === 'POST') { seen.close.push(body()); return route.fulfill({ status: 201, headers: h, body: '' }) } return json([{ friend: OTHER }]) }
    if (p === '/rest/v1/friendships') return json([{ requester: ME, addressee: OTHER }])
    if (p === '/rest/v1/profiles') return json(obj ? (u.searchParams.get('id') === `eq.${OTHER}` ? other : me) : [me, other].filter(x => !u.searchParams.get('id')?.startsWith('in.') || x.id === OTHER))
    if (p === '/rest/v1/memories' && r.method() === 'POST') { seen.memories.push(body()); return json(obj ? { id: 'new-mem' } : [{ id: 'new-mem' }], 201) }
    if (p === '/rest/v1/posts' && r.method() === 'POST') { seen.posts.push(body()); return json(obj ? { id: 'new-post' } : [{ id: 'new-post' }], 201) }
    if (p === '/rest/v1/posts' && r.method() === 'GET') return json(u.searchParams.get('is_reel') ? [reel] : [])
    if (p === '/rest/v1/post_media' && r.method() === 'POST') return route.fulfill({ status: 201, headers: h, body: '' })
    if (p.startsWith('/rest/v1/media_assets') && r.method() === 'POST') return json(obj ? { id: 'a' } : [{ id: 'a' }], 201)
    if (p.startsWith('/functions/v1/')) return json({ ok: true })
    return json(obj ? null : [])
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}
// A small real JPEG made in the browser.
const ctx0 = await browser.newContext(); const p0 = await ctx0.newPage()
const jpeg = Buffer.from(await p0.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const g = c.getContext('2d')
  const gr = g.createLinearGradient(0, 0, 0, 1350); gr.addColorStop(0, '#f08a4b'); gr.addColorStop(0.6, '#c4491c'); gr.addColorStop(1, '#2a0d05'); g.fillStyle = gr; g.fillRect(0, 0, 1080, 1350)
  g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(540, 900, 120, 0, 7); g.fill(); g.fillStyle = '#111'; g.fillRect(380, 420, 320, 90)
  const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)); const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s)
}), 'base64'); await ctx0.close()

// 1. Memory studio: photo → text, sticker, mention, music (with clip), effect → Close Friends.
{
  const t = await open('/app/memories/new')
  await t.page.waitForSelector('.mst-source.hero'); await shot(t.page, '01-memory-start')
  await t.page.locator('input[type=file]').first().setInputFiles({ name: 'grad.jpg', mimeType: 'image/jpeg', buffer: jpeg })
  await t.page.waitForSelector('.mst-rail')
  const labels = await t.page.locator('.mst-label').allInnerTexts()
  check('tool rail: Text, Stickers, Music, Effects, Mention, Draw, Save, More', ['Text', 'Stickers', 'Music', 'Effects', 'Mention', 'Draw', 'Save', 'More'].every(l => labels.includes(l)), labels.join(','))
  await shot(t.page, '02-memory-editor')
  await t.page.getByRole('button', { name: 'Text' }).click()
  await t.page.getByLabel('Your text').fill('Class of 2026')
  await t.page.getByRole('button', { name: 'Strong' }).click(); await shot(t.page, '03-memory-text')
  await t.page.getByRole('button', { name: 'Done' }).click()
  await t.page.getByRole('button', { name: 'Stickers' }).click(); await shot(t.page, '04-memory-stickers')
  await t.page.getByRole('button', { name: 'Sticker 🎓' }).click()
  await t.page.getByRole('button', { name: 'Music' }).click()
  await t.page.waitForSelector('.ms-row'); await t.page.waitForTimeout(400); await shot(t.page, '05-music-sheet')
  check('music sheet: search, For you / Trending / Saved / From device', (await t.page.locator('.ms-chip').allInnerTexts()).join('|') === 'For you|Trending|Saved|From device')
  check('songs show artist • length', (await t.page.locator('.ms-sub').first().innerText()).includes('Jay Anthony • 3:18'))
  await t.page.getByRole('button', { name: 'Use Elad by Jay Anthony' }).click()
  await t.page.waitForSelector('.ms-clip'); await shot(t.page, '06-music-clip')
  await t.page.getByRole('button', { name: 'Done' }).click()
  check('chosen song shows on the canvas', await t.page.locator('.mst-song').isVisible())
  await t.page.getByRole('button', { name: 'Effects' }).click()
  await t.page.getByRole('button', { name: 'Golden' }).click(); await shot(t.page, '07-memory-effects')
  await t.page.locator('.mst-fx-done').click()
  await t.page.locator('.mst-caption').fill('Graduated!')
  await shot(t.page, '08-memory-ready')
  await t.page.getByRole('button', { name: 'More sharing options' }).click()
  await t.page.waitForSelector('.shs-panel'); await t.page.waitForTimeout(400); await shot(t.page, '09-share-sheet')
  await t.page.getByRole('radio', { name: 'Share to Close Friends' }).click()
  await t.page.locator('.shs-go').click()
  await t.page.waitForTimeout(1500)
  const row = t.seen.memories[0] ?? {}
  check('memory row: close friends, song, start, overlays and filter', row.visibility === 'close_friends' && row.music_track_id === 't1' && row.music_title === 'Elad' && row.filter === 'warm' && row.overlays?.length === 2 && row.overlays.some(o => o.t === 'text' && o.text === 'Class of 2026' && o.style === 'bold'), JSON.stringify(row))
  check('the photo uploads to the member’s own folder', t.seen.uploads.some(x => x.path.startsWith(`${ME}/`) && x.type === 'image/jpeg'))
  check('no page errors in the memory studio', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. Viewer: song label, Close Friends badge, sticker, mention and drawing.
{
  const t = await open(`/app/memories/${OTHER}`)
  await t.page.waitForSelector('.mvw-stage'); await t.page.waitForTimeout(600); await shot(t.page, '10-memory-viewer')
  check('viewer shows the song', (await t.page.locator('.mvw-song').innerText()).includes('Elad · Jay Anthony'))
  check('viewer shows the Close Friends badge', await t.page.getByRole('img', { name: 'Close Friends' }).isVisible())
  check('viewer draws sticker, mention link and drawing', await t.page.locator('.ov-sticker').isVisible() && await t.page.locator('a.ov-mention[href="/app/u/alice"]').isVisible() && await t.page.locator('.ov-draw polyline').count() === 1)
  check('no page errors in the viewer', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 3. Reel camera → edit → share.
{
  const t = await open('/app/reels/new')
  await t.page.waitForSelector('.rc-shutter:not([disabled])', { timeout: 15000 }); await t.page.waitForTimeout(800); await shot(t.page, '11-reel-camera')
  check('camera: flash, speed, timer, add audio, tools, Memory/Reel', await t.page.getByRole('button', { name: /Speed 1×/ }).isVisible() && await t.page.getByRole('button', { name: /Timer off/ }).isVisible() && await t.page.getByRole('button', { name: /Add audio/ }).isVisible() && await t.page.locator('.rc-tools button').count() === 5 && (await t.page.locator('.rc-modes').innerText()).includes('REEL'))
  await t.page.getByRole('button', { name: 'Camera settings' }).click(); await t.page.waitForTimeout(300); await shot(t.page, '12-camera-settings')
  await t.page.getByRole('radio', { name: 'Right side' }).check(); await t.page.locator('.cs .shs-go').click()
  check('toolbar moves to the right side', await t.page.locator('.rc-tools.right').isVisible())
  await t.page.getByRole('button', { name: /Speed 1×/ }).click()
  await t.page.getByRole('button', { name: 'Start recording' }).click(); await t.page.waitForTimeout(1300)
  await t.page.getByRole('button', { name: 'Pause recording' }).click(); await shot(t.page, '13-camera-paused')
  await t.page.getByRole('button', { name: 'Continue recording' }).click(); await t.page.waitForTimeout(900)
  await t.page.getByRole('button', { name: 'Pause recording' }).click()
  check('two takes are marked on the progress bar', await t.page.locator('.rc-progress b').count() === 2)
  await t.page.getByRole('button', { name: 'Next: edit your reel' }).click()
  await t.page.waitForSelector('.re-toolbar', { timeout: 10000 }); await t.page.waitForTimeout(800)
  await t.page.getByRole('button', { name: 'Effects' }).click(); await t.page.getByRole('button', { name: 'Noir' }).click(); await shot(t.page, '14-reel-edit')
  await t.page.getByRole('button', { name: 'Volume' }).click(); await t.page.locator('.re-slider input').first().fill('0.4')
  await t.page.getByRole('button', { name: 'Next' }).click()
  await t.page.locator('.re-field textarea').fill('First reel'); await t.page.waitForTimeout(800); await shot(t.page, '15-reel-details')
  await t.page.getByRole('button', { name: /^Share$|%/ }).click()
  await t.page.waitForTimeout(2500)
  const post = t.seen.posts[0] ?? {}
  check('reel row: video, is_reel, settings (speed from the camera, effect, volume)', post.is_reel === true && post.media_type === 'video' && post.reel_edit?.filter === 'noir' && post.reel_edit?.speed === 2 && post.reel_edit?.ov === 0.4, JSON.stringify(post))
  check('no page errors in the reel camera and editor', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 4. Reels viewer.
{
  const t = await open('/app/reels')
  await t.page.waitForSelector('.reel'); await t.page.waitForTimeout(800); await shot(t.page, '16-reels')
  check('reels: For you / Friends tabs', (await t.page.locator('.reels-tabs').innerText()).replace(/\s+/g, ' ').includes('For you Friends'))
  check('reel plays with its effect', ((await t.page.locator('.reel-video').first().getAttribute('style')) ?? '').includes('sepia'))
  check('song disc to reuse the audio', await t.page.getByRole('button', { name: 'Use this audio: Elad' }).isVisible())
  await t.page.getByRole('button', { name: 'More options' }).click(); await t.page.waitForTimeout(300); await shot(t.page, '17-reel-menu')
  check('reel menu: speed, copy link, report', await t.page.getByRole('radio', { name: '1.5×' }).isVisible() && await t.page.getByRole('button', { name: 'Report' }).isVisible())
  check('no page errors in reels', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 5. Discover music (light and dark).
for (const scheme of ['dark', 'light']) {
  const t = await open('/app/music', { scheme })
  await t.page.waitForSelector('.mu-concert'); await t.page.waitForTimeout(600); await shot(t.page, `18-music-${scheme}`)
  if (scheme === 'dark') {
    check('artist names set as posters (uppercase, heavy)', await t.page.locator('.mu-artist .mu-name').first().evaluate(e => getComputedStyle(e).textTransform === 'uppercase' && Number(getComputedStyle(e).fontWeight) >= 800))
    check('concert row: date, NAME, venue, city • distance', (await t.page.locator('.mu-concert').innerText()).replace(/\s+/g, ' ').match(/30.*2026 HUGEL St\. Pete Pier Saint Petersburg • 13360 km/) != null, await t.page.locator('.mu-concert').innerText())
    await t.page.getByRole('button', { name: 'More for HUGEL', exact: true }).click(); await t.page.waitForTimeout(300); await shot(t.page, '19-concert-menu')
    const items = await t.page.locator('.ss-menu').innerText()
    check('concert menu: view all, view artist, Apple Music, Spotify, YouTube Music, YouTube, share, save', ['View all concerts', 'View artist', 'Apple Music', 'Spotify', 'YouTube Music', 'YouTube', 'Share', 'Save concert'].every(x => items.includes(x)))
    await t.page.keyboard.press('Escape')
    await t.page.getByRole('button', { name: 'Elad by Jay Anthony: options' }).click(); await t.page.waitForTimeout(300); await shot(t.page, '20-song-menu')
    { const m = await t.page.locator('.ss-menu').innerText(); check('song menu: memory, reel, post', ['Add to a memory', 'Make a reel', 'Share in a post'].every(x => m.includes(x))) }
  }
  check(`no page errors on Discover music (${scheme})`, t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
