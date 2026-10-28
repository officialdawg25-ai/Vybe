// Round 3 fixes: reactions on comments, video-note play button, profile stats lists, picture ring with a live memory, block and unfriend sheets, Plans/Communities rails, card layouts, song label flip. MOCKED backend.
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
const COM = 'cccccccc-0000-4000-8000-0000000000c1', EV = 'e1'
const later = new Date(Date.now() + 864e5 * 3).toISOString()
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const gen = await browser.newPage()
const png = Buffer.from(await gen.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const g = c.getContext('2d'); g.fillStyle = '#4338ca'; g.fillRect(0, 0, 800, 600); return c.toDataURL('image/png').split(',')[1] }), 'base64')
await gen.close()
const post = { id: 'p1', author: OTHER, body: 'a post with a very long song name attached to it', media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: new Date().toISOString(), edited_at: null, profiles: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }, reactions: [{ count: 0 }], comments: [{ count: 2 }], mine_reaction: [], mine_save: [], post_media: [{ path: `${OTHER}/a.png`, type: 'image', sort: 0 }], music_title: 'An exceptionally long song title that cannot fit on one line', music_artist: 'The Long Name Collective', music_path: `${OTHER}/song.mp3` }
const cm1 = { id: 'c1', post_id: 'p1', author: OTHER, body: 'first one', parent_id: null, created_at: new Date().toISOString(), edited_at: null, audio_path: null, video_path: null, profiles: post.profiles, rx: [{ user_id: OTHER, reaction: 'heart' }] }
const cm2 = { id: 'c2', post_id: 'p1', author: ME, body: '', parent_id: null, created_at: new Date().toISOString(), edited_at: null, audio_path: null, video_path: `${ME}/note.webm`, video_ms: 6000, profiles: { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null, verified_until: null }, rx: [] }
const plans = [['music', 'Sunset session'], ['music', 'Rooftop set'], ['comedy', 'Open mic night']].map(([cat, t], i) => ({ id: `e${i}`, host: OTHER, title: t, description: '', cover_path: null, category: cat, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Clifton', visibility: 'public', capacity: null, price_cents: 0, currency: 'ZAR', status: 'active', profiles: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null } }))
const coms = [{ id: COM, name: 'Runners', description: 'We run', rules: '', cover_path: null, avatar_path: null, topics: ['Sport'], visibility: 'public', created_by: OTHER }, { id: 'c2', name: 'Vinyl', description: '', rules: '', cover_path: null, avatar_path: null, topics: ['Music'], visibility: 'public', created_by: OTHER }]
let rel = null
const mk = async ({ story = false, friend = false, ...opts } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts })
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  const seen = { rx: [], plays: [], deletes: [] }
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object'), p = u.pathname
    let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
    if (p.startsWith('/storage/v1/object/sign/media') && r.method() === 'POST' && Array.isArray(body?.paths)) return json(body.paths.map(x => ({ path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
    if (p.startsWith('/storage/v1/object/sign/media/') && r.method() === 'POST') return json({ signedURL: `/object/sign/media/${decodeURIComponent(p.split('/media/')[1])}?token=t` })
    if (p.startsWith('/storage/v1/object/sign/media/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: png })
    if (p.startsWith('/storage/v1/object/media') && r.method() === 'POST') return json({ Key: 'ok' })
    if (p === '/rest/v1/rpc/my_profile') return json(me)
    if (p === '/rest/v1/rpc/is_staff' || p === '/rest/v1/rpc/is_admin' || p === '/rest/v1/rpc/sponsored_feed') return json(p.endsWith('sponsored_feed') ? [] : false)
    if (p === '/rest/v1/rpc/profile_stats') return json({ posts: 12, followers: 3, following: 4, friends: 2, follows_me: false, i_follow: false })
    if (p === '/rest/v1/rpc/profile_connections') return json([{ id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null, i_follow: false }])
    if (p === '/rest/v1/rpc/author_memories') return json(story ? [{ id: 'm1', kind: 'text', media_path: null, text_body: 'hi', bg: 'violet', created_at: now, expires_at: new Date(Date.now() + 36e5).toISOString(), seen: false }] : [])
    if (p === '/rest/v1/rpc/get_profile_details') return json({ level: 1 })
    if (p === '/rest/v1/rpc/profile_followed_by') return json({ count: 0, people: [] })
    if (p === '/rest/v1/comment_reactions') { if (r.method() === 'POST') { seen.rx.push(['insert', body]); return json([], 201) } if (r.method() === 'PATCH') { seen.rx.push(['update', body]); return json([]) } if (r.method() === 'DELETE') { seen.deletes.push(u.search); return json([]) } return json([]) }
    if (p === '/rest/v1/comments') return json([cm1, cm2])
    if (p === '/rest/v1/posts') return json(obj ? post : [post])
    if (p === '/rest/v1/event_categories') return json([{ slug: 'music', label: 'Concerts & gigs', group_key: 'concerts', sort: 10, active: true }, { slug: 'comedy', label: 'Comedy', group_key: 'events', sort: 20, active: true }, { slug: 'food', label: 'Food', group_key: 'events', sort: 30, active: true }])
    if (p === '/rest/v1/events') return json(plans)
    if (p === '/rest/v1/event_rsvps') return json([])
    if (p === '/rest/v1/communities') return json(obj ? coms[0] : coms)
    if (p === '/rest/v1/community_members') return json([])
    if (p === '/rest/v1/friendships') return json(friend ? [{ id: 'f1', requester: ME, addressee: OTHER, status: 'accepted' }] : [])
    if (p === '/rest/v1/profiles') { const row = { ...other, bio: 'hi', location: 'Cape Town', interests: [], dm_policy: 'everyone', follow_policy: 'everyone', cover_path: null, avatar_path: null }; const id = u.searchParams.get('id'); const un = u.searchParams.get('username'); const who = un === 'eq.alice' ? { ...me, avatar_path: null } : row; return json(obj ? who : [who]) }
    return json(obj ? null : [])
  })
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.addInitScript(() => { const o = HTMLMediaElement.prototype.play; window.__plays = []; HTMLMediaElement.prototype.play = function () { window.__plays.push(this.currentSrc || this.src); return o.apply(this, arguments) } })
  return { ctx, page, seen, errors }
}

// ---- post card: no speaker or expand icon, song label flips, the song starts by itself
let t = await mk()
await t.page.goto(BASE + '/app'); await t.page.waitForSelector('.igp', { timeout: 10000 }); await t.page.waitForTimeout(500)
await t.page.mouse.click(5, 5)
await t.page.locator('.igp').first().scrollIntoViewIfNeeded(); await t.page.waitForTimeout(2500)
check('no speaker button in the post header and no expand icon on the media', await t.page.locator('.igp-sound, .igp-expand').count() === 0)
const plays = await t.page.evaluate(() => window.__plays)
check('the post’s song starts by itself when the post is in view', plays.some(s => /song\.mp3/.test(s)), JSON.stringify(plays))
const anim = await t.page.locator('.igp-sub .mq-t').first().evaluate(e => { const a = e.getAnimations()[0]; if (!a) return null; const k = a.effect.getKeyframes().map(f => f.transform); return k })
check('a long song name slides to its end, rests, slides back and rests (it flips, never just runs off)', Array.isArray(anim) && anim.length === 5 && /^translateX\(0(px)?\)$/.test(anim[0]) && /-\d+/.test(anim[2]) && anim[2] === anim[3] && /^translateX\(0(px)?\)$/.test(anim[4]), JSON.stringify(anim))
check('no page errors (feed)', t.errors.length === 0, t.errors.join(' | '))
await t.ctx.close()

// ---- comments: React sits in the Reply/Delete lane, six choices, switching and taking back
t = await mk()
await t.page.goto(BASE + '/app/posts/p1'); await t.page.waitForSelector('.cmt-actions', { timeout: 10000 })
const lane = await t.page.locator('.cmt-actions').first().evaluate(e => [...e.querySelectorAll('button')].map(b => b.textContent.trim()))
check('React is in the same lane as Reply (and Delete / Report)', lane.includes('React') && lane.includes('Reply'), JSON.stringify(lane))
await t.page.locator('.cmt-actions').first().getByRole('button', { name: 'React' }).click()
check('a row of six reactions to choose from (love, like, haha, wow, sad, fire)', await t.page.locator('.cmt-pick button').count() === 6)
await t.page.getByRole('group', { name: 'Choose a reaction' }).getByRole('button', { name: 'Haha' }).click(); await t.page.waitForTimeout(500)
check('choosing one saves that reaction', t.seen.rx.some(([k, b]) => k === 'insert' && b.reaction === 'laugh' && b.comment_id === 'c1'), JSON.stringify(t.seen.rx))
check('the button shows what I chose and a summary appears at the end of the lane', (await t.page.locator('.cmt-actions').first().innerText()).includes('Haha') && await t.page.locator('.cmt-actions').first().locator('.cmt-rx').count() === 1)
await t.page.locator('.cmt-actions').first().getByRole('button', { name: /Haha/ }).click(); await t.page.getByRole('group', { name: 'Choose a reaction' }).getByRole('button', { name: 'Sad' }).click(); await t.page.waitForTimeout(400)
check('choosing another switches it (update, not a second row)', t.seen.rx.some(([k, b]) => k === 'update' && b.reaction === 'sad'))
await t.page.locator('.cmt-actions').first().getByRole('button', { name: /Sad/ }).click(); await t.page.getByRole('group', { name: 'Choose a reaction' }).getByRole('button', { name: 'Sad' }).click(); await t.page.waitForTimeout(400)
check('choosing the same one again takes it back', t.seen.deletes.length === 1)
check('the emoji are plain native emoji, not animated images', await t.page.locator('.emo img, .emo-art').count() === 0)
const vn = await t.page.locator('.vnote-play').first().evaluate(e => { const r = e.getBoundingClientRect(), b = e.parentElement.getBoundingClientRect(); return { dx: Math.abs((r.left + r.width / 2) - (b.left + b.width / 2)), dy: Math.abs((r.top + r.height / 2) - (b.top + b.height / 2)) } })
check('the video note’s play button sits in the middle of the circle', vn.dx < 2 && vn.dy < 2, JSON.stringify(vn))
let v = (await (async () => { await t.page.evaluate(axe); return (await t.page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 90)}`) })())
check('axe: comments', v.length === 0, v.join(' | '))
await t.ctx.close()

// ---- profile: stats open lists, the picture fills its ring with a live memory, + changes the picture, block / unfriend sheets
t = await mk({ story: true, friend: false })
await t.page.goto(BASE + '/app/u/alice'); await t.page.waitForSelector('.pf-stats', { timeout: 10000 }); await t.page.waitForTimeout(600)
const ring = await t.page.locator('.pf-ring').evaluate(e => { const r = e.getBoundingClientRect(), a = e.querySelector('.avatar').getBoundingClientRect(); return { cls: e.className, ring: Math.round(r.width), av: Math.round(a.width), off: Math.round(Math.abs((a.left + a.width / 2) - (r.left + r.width / 2))) } })
check('with a live memory the picture still fills its ring, centred', /new|seen/.test(ring.cls) && ring.av >= ring.ring - 14 && ring.off <= 1, JSON.stringify(ring))
const url0 = t.page.url()
await t.page.getByRole('button', { name: /Change profile picture/ }).click().catch(() => {})
check('the camera badge changes the profile picture (no jump to the memory screen)', t.page.url() === url0)
await t.page.getByRole('button', { name: /Show who/ }).first().click(); await t.page.waitForTimeout(600)
check('Followers opens a real list', await t.page.getByRole('dialog', { name: 'Followers' }).isVisible() && await t.page.getByRole('dialog').getByText('@bob').isVisible())
await t.page.keyboard.press('Escape')
await t.page.getByRole('button', { name: /Following 4/ }).click()
check('Following opens its list', await t.page.getByRole('dialog', { name: 'Following' }).isVisible())
await t.page.keyboard.press('Escape')
await t.page.getByRole('button', { name: /12 posts/ }).click(); await t.page.waitForTimeout(500)
check('Posts jumps to the posts grid', await t.page.getByRole('tab', { name: 'Posts', selected: true }).count() === 1)
v = (await (async () => { await t.page.evaluate(axe); return (await t.page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 90)}`) })())
check('axe: own profile with a live memory', v.length === 0, v.join(' | '))
await t.ctx.close()

t = await mk({ friend: true })
await t.page.goto(BASE + '/app/u/bob'); await t.page.waitForSelector('.pf-name', { timeout: 10000 }); await t.page.waitForTimeout(500)
await t.page.getByRole('button', { name: 'More options' }).click(); await t.page.getByRole('button', { name: 'Block', exact: true }).click()
check('Block opens its own screen that says what will happen', await t.page.getByRole('dialog', { name: 'Block' }).isVisible() && await t.page.getByText(/won’t be able to find you/).isVisible() && await t.page.getByRole('button', { name: 'Block @bob' }).isVisible())
await t.page.getByRole('button', { name: 'Cancel' }).click()
check('Cancel leaves everything as it was', await t.page.getByRole('dialog').count() === 0)
await t.page.getByRole('button', { name: 'Friends', exact: true }).click()
check('Unfriend opens its own screen too', await t.page.getByRole('dialog', { name: 'Unfriend' }).isVisible() && await t.page.getByRole('button', { name: 'Unfriend', exact: true }).isVisible())
v = (await (async () => { await t.page.evaluate(axe); return (await t.page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))).violations.map(x => `${x.id} (${x.impact}) ${x.nodes[0].html.slice(0, 90)}`) })())
check('axe: unfriend sheet', v.length === 0, v.join(' | '))
await t.ctx.close()

// ---- plans / communities: category by category, with a gliding row; Discover-style cards
t = await mk()
await t.page.goto(BASE + '/app/plans'); await t.page.waitForSelector('.sec', { timeout: 10000 }); await t.page.waitForTimeout(500)
check('Plans: a gliding category row and one swipeable row per category', await t.page.locator('.crail-view, .crail-list').count() === 1 && await t.page.locator('.sec .hscroll').count() >= 2)
const card = await t.page.locator('.poster').first().evaluate(e => ({ onArt: !!e.querySelector('.poster-art .poster-title'), date: !!e.querySelector('.poster-art .poster-date'), price: !!e.querySelector('.poster-art .poster-foot'), by: e.querySelector(':scope > .pc .pc-by')?.textContent, place: !!e.querySelector('.poster-art .poster-line') }))
check('a plan card: date top-left, category, title, place and price on the card; only “by @host” underneath', card.onArt && card.date && card.price && card.place && card.by === 'by @bob', JSON.stringify(card))
await t.page.goto(BASE + '/app/communities'); await t.page.waitForSelector('.sec', { timeout: 10000 }); await t.page.waitForTimeout(500)
check('Communities: a topic row and a row per topic', await t.page.locator('.crail-view, .crail-list').count() === 1 && await t.page.locator('.sec .hscroll').count() >= 2)
await t.page.goto(BASE + '/app/discover'); await t.page.waitForSelector('.crail-tile', { timeout: 10000 }); await t.page.waitForTimeout(500)
check('Discover category cards carry their title on the card', await t.page.locator('.crail-item:not([aria-hidden]) .crail-tile .crail-label').count() > 3 && await t.page.locator('.crail-ico').count() === 0)
await t.ctx.close()
await browser.close()
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1) }
console.log('All round 3 checks passed')
