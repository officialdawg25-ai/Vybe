// Browser checks for the production-readiness fixes, against a MOCKED backend (never a real one):
//   secure-chat setup, avatar healing, logo refresh, post submission, memory rail close, billboard fallback, Discover hero.
// The mock mirrors the database rules these fixes depend on — notably chat_keys refuses an upsert (the column grant does), which
// is what broke "Turn on secure chat" in production while the older mocks happily accepted it.
//
//   VITE_SUPABASE_URL=https://mock.supabase.test VITE_SUPABASE_PUBLISHABLE_KEY=mock npx vite build --outDir dist-mock
//   npx vite preview --outDir dist-mock --port 4174 &
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/production-check.mjs
import { webcrypto } from 'node:crypto'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64u({ alg: 'none' })}.${b64u({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const OLD_AV = `${BOB}/11111111-0000-4000-8000-000000000000.webp`, NEW_AV = `${BOB}/22222222-0000-4000-8000-000000000000.webp`
const bobKey = await (async () => { const k = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); return Buffer.from(await webcrypto.subtle.exportKey('raw', k.publicKey)).toString('base64') })()

const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', follow_policy: 'everyone', show_followers: 'public', notif_prefs: {}, onboarded_at: now, verified_until: null }
const bob = { id: BOB, username: 'bob', display_name: 'Bob', avatar_path: NEW_AV, verified_until: null }
const mkPost = (id, body, author = bob, minutesAgo = 0) => ({ id, author: author.id, body, media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), edited_at: null, profiles: author, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], post_media: [], tags: [] })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
// Each section runs on its own: a missing control (e.g. in an older build) fails that section, not the run.
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ url = '/app', width = 390, height = 844, posts = () => [mkPost('p1', 'Sunset run', { ...bob, avatar_path: OLD_AV }, 5)], rail = [], slides = { home: [], discover: [] }, trending = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const srv = { keys: {}, backups: {}, keyWrites: [], postWrites: [], messageWrites: [], postsGets: 0, signed: [], profileLookups: 0, created: null }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', async route => {
    const r = route.request(), u = new URL(r.url()), m = r.method()
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const p = u.pathname

    // Storage: the replaced avatar no longer exists, so it cannot be signed (as in production after saveAvatar deletes it).
    if (p === '/storage/v1/object/sign/media' && m === 'POST') {
      const paths = body()?.paths ?? []
      srv.signed.push(...paths)
      return json(paths.map(x => (x === OLD_AV ? { path: x, signedURL: null, error: 'Object not found' } : { path: x, signedURL: `/object/sign/media/${x}?token=t`, error: null })))
    }
    const one = p.match(/^\/storage\/v1\/object\/sign\/media\/(.+)$/)
    if (one && m === 'POST') { const x = decodeURIComponent(one[1]); srv.signed.push(x); return x === OLD_AV ? json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 400) : json({ signedURL: `/object/sign/media/${x}?token=t` }) }
    if (p.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })

    if (p.startsWith('/rest/v1/rpc/')) {
      const name = p.replace('/rest/v1/rpc/', '')
      const R = { memory_rail: rail, author_memories: [], music_catalog: [], discover_events: [], discover_orgs: [], discover_live: [], trending_events: trending, home_hero_settings: { trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 }, is_staff: false, is_admin: false, unread_messages: 0, profile_stats: { friends: 1, posts: 1, followers: 1, following: 1, i_follow: true, follows_me: true }, people_suggestions: [], promo_track: true }
      // Like PostgREST: a function the database does not have is a 404 (PGRST202), not an empty success. This is what an
      // older database without migration 14 answers for publish_chat_key, so the app's direct-write fallback is exercised.
      return name in R ? json(R[name]) : json({ code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` }, 404)
    }
    const t = p.replace('/rest/v1/', '')

    // chat_keys behaves like the real table: INSERT and UPDATE(public_key, updated_at) are allowed, an upsert is not.
    if (t === 'chat_keys' || t === 'chat_key_backups') {
      const store = t === 'chat_keys' ? srv.keys : srv.backups
      if (m === 'POST') {
        const b = body(), upsert = (r.headers().prefer ?? '').includes('resolution=merge-duplicates')
        srv.keyWrites.push({ t, upsert })
        if (t === 'chat_keys' && upsert) return json({ code: '42501', message: 'permission denied for table chat_keys' }, 403)
        if (t === 'chat_keys' && store[b.user_id]) return json({ code: '23505', message: 'duplicate key value violates unique constraint "chat_keys_pkey"' }, 409)
        store[b.user_id] = t === 'chat_keys' ? b.public_key : b.backup
        return route.fulfill({ status: 201, headers: h, body: '' })
      }
      if (m === 'PATCH') {
        const id = (u.searchParams.get('user_id') ?? '').replace('eq.', ''), b = body()
        srv.keyWrites.push({ t, patch: true })
        if (!store[id]) return json([])
        store[id] = t === 'chat_keys' ? b.public_key : b.backup
        return json([{ user_id: id }])
      }
      const f = u.searchParams.get('user_id') ?? '', ids = f.startsWith('in.') ? f.slice(4, -1).split(',') : [f.replace('eq.', '')]
      const all = { ...store, ...(t === 'chat_keys' ? { [BOB]: bobKey } : {}) }
      const out = ids.filter(i => all[i]).map(i => (t === 'chat_keys' ? { user_id: i, public_key: all[i] } : { user_id: i, backup: all[i] }))
      return json(obj ? (out[0] ?? null) : out)
    }

    if (m === 'POST') {
      const b = body()
      if (t === 'posts') { srv.postWrites.push(b); await new Promise(r => setTimeout(r, 250)); srv.created = { ...mkPost('newpost', b.body, me), created_at: new Date().toISOString() }; return json({ id: 'newpost' }, 201) }
      if (t === 'messages') { srv.messageWrites.push(b); return json({ id: 'srv' + srv.messageWrites.length, created_at: new Date().toISOString(), deleted_at: null, ...b }, 201) }
      return route.fulfill({ status: 201, headers: h, body: '' })
    }
    if (m === 'PATCH') return route.fulfill({ status: 204, headers: h, body: '' })

    if (t === 'posts') {
      srv.postsGets++
      const idf = u.searchParams.get('id') ?? ''
      let list = posts(srv.postsGets)
      if (srv.created) list = [srv.created, ...list]
      if (idf.startsWith('in.')) { const want = idf.slice(4, -1).split(','); list = list.filter(x => want.includes(x.id)) }
      if (u.searchParams.get('select') === 'id') list = list.map(x => ({ id: x.id }))
      return json(list)
    }
    if (t === 'promo_slides') {
      const pl = (u.searchParams.get('placements') ?? '').match(/\{(\w+)\}/)?.[1] ?? 'home'
      return json(slides[pl] ?? [])
    }
    if (t === 'profiles') {
      const idf = u.searchParams.get('id') ?? ''
      if (idf.startsWith('in.')) { srv.profileLookups++; return json([bob].filter(x => idf.includes(x.id)).map(x => ({ id: x.id, avatar_path: x.avatar_path }))) }
      return json(obj ? me : [me])
    }
    const rows = {
      conversations: [{ id: 'cv1', is_group: false, title: null }],
      conversation_members: [{ conversation_id: 'cv1', user_id: BOB, last_read_at: now, profiles: bob, conversations: { id: 'cv1', is_group: false, title: null } }],
      messages: [], friendships: [{ id: 'f1', requester: ME, addressee: BOB, status: 'accepted' }],
    }[t] ?? []
    return json(obj ? (rows[0] ?? null) : rows)
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + url); await page.waitForTimeout(1000)
  return { page, ctx, srv, errs }
}

/* ------------------------------------------------------------------------------------------------ secure chat set-up */
try {
  const { page, ctx, srv, errs } = await open({ url: '/app/messages/cv1' })
  check('a one-to-one chat asks to turn on secure chat before sending', await page.getByRole('button', { name: 'Turn on' }).isVisible())
  await page.getByRole('button', { name: 'Turn on' }).click()
  await page.getByLabel('Choose a chat passphrase').fill('correct horse battery staple')
  await page.getByLabel('Type it again').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Turn on secure chat' }).click()
  // Set-up ends by showing the one-time recovery key, which must be acknowledged before the chat opens.
  const rec = page.getByRole('dialog', { name: 'Save your recovery key' })
  await rec.waitFor({ timeout: 15000 }).catch(() => {})
  if (await rec.isVisible()) { await page.getByLabel(/I have saved my recovery key/).check(); await rec.getByRole('button', { name: 'Done' }).click() }
  await page.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 15000 }).catch(() => {})
  const alert = await page.locator('.sheet [role=alert]').textContent().catch(() => null)
  check('turning on secure chat succeeds against a table that refuses upserts', !alert && Boolean(srv.keys[ME]), alert ?? '')
  check('the public key is published without an upsert (update, then insert)', srv.keyWrites.filter(w => w.t === 'chat_keys' && w.upsert).length === 0 && srv.keyWrites.some(w => w.t === 'chat_keys' && w.patch), JSON.stringify(srv.keyWrites))
  check('the passphrase-encrypted backup is stored, and never the passphrase itself', Boolean(srv.backups[ME]?.ct) && !JSON.stringify(srv.backups).includes('horse'))
  await page.waitForTimeout(600)
  check('the composer appears and the thread says it is end-to-end encrypted', await page.getByRole('textbox', { name: 'Message' }).isVisible() && await page.getByText('End-to-end encrypted').isVisible())
  await page.getByRole('textbox', { name: 'Message' }).fill('See you at 7', { timeout: 3000 })
  await page.getByRole('button', { name: 'Send message' }).click(); await page.waitForTimeout(800)
  const sent = srv.messageWrites[0]
  check('the message is sent as ciphertext only', sent?.e2ee === true && sent.body.startsWith('e2ee1.') && !sent.body.includes('See you'), JSON.stringify(sent ?? null).slice(0, 120))
  check('the sender still reads their own message', await page.getByText('See you at 7').isVisible())
  check('no page errors (secure chat)', !errs.length, errs.join(' | '))
  await ctx.close()
} catch (e) { failures++; console.log(`✗ section stopped — ${String(e.message).split('\n')[0]}`) }

/* ------------------------------------------------------------------------------------------------ avatar healing */
try {
  const { page, ctx, srv, errs } = await open({})
  await page.waitForTimeout(1500)
  const src = await page.locator('article .avatar-img, .post .avatar-img').first().getAttribute('src').catch(() => null)
  check('a post carrying a replaced (deleted) avatar path heals to the member’s current picture', Boolean(src?.includes(NEW_AV)), String(src))
  check('healing asked the database once for that member', srv.profileLookups === 1, String(srv.profileLookups))
  check('no page errors (avatars)', !errs.length, errs.join(' | '))
  await ctx.close()
} catch (e) { failures++; console.log(`✗ section stopped — ${String(e.message).split('\n')[0]}`) }

/* ------------------------------------------------------------------------------------------------ billboard + logo + create */
try {
  let published = false                      // the new post exists on the server only after the logo tap
  const { page, ctx, srv, errs } = await open({ posts: () => (published ? [mkPost('p2', 'Fresh from the beach', bob, 1), mkPost('p1', 'Sunset run', bob, 5)] : [mkPost('p1', 'Sunset run', bob, 5)]) })
  check('with no trending plans and no approved slides the billboard keeps its place with VYBE’s own card', await page.locator('.billboard .bb-house').isVisible() && (await page.locator('.billboard .bb-title').textContent({ timeout: 2000 }).catch(() => null)) === 'Life is better together')
  check('the house card is labelled as VYBE’s, not as sponsored', (await page.locator('.billboard .bb-eyebrow').textContent({ timeout: 2000 }).catch(() => null)) === 'From VYBE' && await page.locator('.billboard .bb-ad').count() === 0)
  check('Home asks for the feed once per visit', srv.postsGets === 1, String(srv.postsGets))
  const before = srv.postsGets
  published = true
  await page.getByRole('link', { name: 'VYBE home' }).click(); await page.waitForTimeout(900)
  check('tapping the VYBE logo on Home re-checks the server', srv.postsGets > before, `${before} → ${srv.postsGets}`)
  check('…and the new post appears without a page reload', await page.getByText('Fresh from the beach').isVisible())
  check('…while the URL stays on Home', new URL(page.url()).pathname === '/app')

  await page.goto(BASE + '/app/create'); await page.waitForTimeout(700)
  await page.getByRole('textbox').first().fill('Golden hour with the crew')
  const btn = page.getByRole('button', { name: 'Post', exact: true })
  await btn.dblclick()
  await page.waitForURL(u => new URL(u).pathname === '/app', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  check('a double tap on Post creates exactly one post', srv.postWrites.length === 1, String(srv.postWrites.length))
  check('a successful post returns to Home', new URL(page.url()).pathname === '/app')
  check('…with a short “Post shared” confirmation', await page.getByRole('status').filter({ hasText: 'Post shared' }).count() === 1)
  check('…and the new post is on Home straight away', await page.getByText('Golden hour with the crew').isVisible())
  const state = await page.evaluate(() => window.history.state?.usr ?? null)
  check('the confirmed post is cleared from history, so a reload never replays it', state === null, JSON.stringify(state))
  check('no page errors (feed / create)', !errs.length, errs.join(' | '))
  await ctx.close()
} catch (e) { failures++; console.log(`✗ section stopped — ${String(e.message).split('\n')[0]}`) }

/* ------------------------------------------------------------------------------------------------ create opened directly */
try {
  const { page, ctx } = await open({ url: '/app/create' })
  await page.getByRole('button', { name: 'Close' }).click(); await page.waitForTimeout(500)
  check('closing a composer opened directly goes to Home instead of leaving VYBE', new URL(page.url()).pathname === '/app', page.url())
  await ctx.close()
} catch (e) { failures++; console.log(`✗ section stopped — ${String(e.message).split('\n')[0]}`) }

/* ------------------------------------------------------------------------------------------------ memory rail */
try {
  const people = Array.from({ length: 9 }, (_, i) => ({ author: { id: `cccccccc-0000-4000-8000-00000000000${i}`, username: `p${i}`, display_name: `Person ${i}`, avatar_path: null, verified_until: null }, count: 1, unseen: 1, latest_at: now, friend: true, cover: { kind: 'text', media_path: null, text_body: `Memory ${i}`, bg: 'rose' } }))
  const { page, ctx, errs } = await open({ rail: people })
  await page.locator('.mrail .mc').first().click(); await page.waitForTimeout(450)
  check('one tap opens the rail', await page.locator('.mrail.open').count() === 1)
  const closeVisible = async () => page.getByRole('button', { name: 'Close the shortcuts' }).evaluate(b => { const r = b.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= 0 && r.width > 0 })
  check('Close is visible without scrolling to the end of the rail', await closeVisible())
  await page.locator('.mrail-list').evaluate(l => l.scrollTo({ left: 300 })); await page.waitForTimeout(200)
  check('…and stays visible while the rail is scrolled', await closeVisible())
  await page.getByRole('button', { name: 'Close the shortcuts' }).click(); await page.waitForTimeout(450)
  const folded = await page.evaluate(() => ({ stacked: !!document.querySelector('.mrail.stacked'), left: document.querySelector('.mrail-list').scrollLeft }))
  check('one tap on Close folds it back to the left (scroll reset, stack restored)', folded.stacked && folded.left === 0, JSON.stringify(folded))
  check('…and nothing on Home is left blocked', await page.evaluate(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight - 140); return Boolean(el && !el.closest('.mrail')) }))
  await page.locator('.mrail .mc').first().click(); await page.waitForTimeout(300)
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  check('Escape folds the rail too', await page.locator('.mrail.stacked').count() === 1)
  check('no page errors (rail)', !errs.length, errs.join(' | '))
  await ctx.close()
} catch (e) { failures++; console.log(`✗ section stopped — ${String(e.message).split('\n')[0]}`) }

/* ------------------------------------------------------------------------------------------------ Discover hero */
try {
  const slide = (id, title, label, advertiser = '') => ({ id, advertiser, title, subtitle: 'Live this weekend', cta_label: 'See more', cta_url: '/app/discover?mode=concerts', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#e0457b', sound: 'none', city: null, priority: 50, placements: ['discover'], kind: label })
  let t = await open({ url: '/app/discover', slides: { home: [], discover: [slide('d1', 'Summer Sessions', 'sponsored', 'Acme Live'), slide('d2', 'Find your people', 'house')] } })
  check('Discover has its own hero at the top, from its own placement', await t.page.locator('.billboard.bb-discover').isVisible() && await t.page.getByText('Summer Sessions').isVisible())
  check('a paid slide is labelled Sponsored with the advertiser', (await t.page.locator('.billboard.bb-discover .bb-eyebrow').textContent({ timeout: 2000 }).catch(() => null)) === 'Sponsored · Acme Live')
  await t.page.getByRole('button', { name: 'Next slide' }).click(); await t.page.waitForTimeout(300)
  check('slides can be changed by hand; a house slide says From VYBE', await t.page.getByText('Find your people').isVisible() && (await t.page.locator('.billboard.bb-discover .bb-eyebrow').textContent({ timeout: 2000 }).catch(() => null)) === 'From VYBE')
  check('the hero does not push Discover’s own controls off the first screen', await t.page.getByText('Explore:').isVisible())
  check('no horizontal overflow on Discover at phone width', !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
  check('no page errors (Discover hero)', !t.errs.length, t.errs.join(' | '))
  await t.ctx.close()
  t = await open({ url: '/app/discover' })
  check('with no live Discover slides the hero shows VYBE’s own card', (await t.page.locator('.billboard.bb-discover .bb-eyebrow').textContent({ timeout: 3000 }).catch(() => null)) === 'From VYBE' && await t.page.getByText('Discover what moves you').isVisible())
  await t.ctx.close()
} catch (e) { failures++; console.log(`✗ section stopped — ${String(e.message).split('\n')[0]}`) }

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
