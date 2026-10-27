// Browser checks for round 4 against a MOCKED backend: the event page's artwork/video header and its editor, the
// "how many are going" count with a privacy-respecting list on request, the gliding category rail (and its still
// version for reduced motion), category screens, admin tile covers, and the full-screen map. Screenshots go to SHOTS.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const SHOTS = process.env.SHOTS ?? ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5 * 3).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'mashao', display_name: 'Mashao McCoy Lebepe', bio: '', avatar_path: null, location: 'Thohoyandou', lat: -22.95, lng: 30.48, interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const card = (n, extra = {}) => ({ id: `e${n}`, title: n === 1 ? 'Sunset beach braai' : `Gig ${n}`, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', city: 'Thohoyandou', venue: 'The Roof', location: null, cover_path: null, category: 'food', category_label: 'Food & lifestyle', format: 'hybrid', lat: -22.95 + n * 0.01, lng: 30.48 + n * 0.012, distance_km: 2 * n, source: 'vybe', source_name: null, price_from_cents: 10000, price_cents: 10000, currency: 'ZAR', has_tickets: true, going: 14, friends_going: 2, friend_avatars: [{ username: 'bob', display_name: 'Bob', avatar_path: null }], followed: false, live: false, artists: [], host: { ...other, display_name: 'Mashao McCoy Lebepe' }, org: null, ...extra })
const EVENT = (x = {}) => ({ id: 'e1', host: ME, title: 'Sunset beach braai', description: 'Bring friends', cover_path: null, hero_video_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: null, visibility: 'public', capacity: null, community_id: null, price_cents: 10000, currency: 'ZAR', ticket_url: null, status: 'active', category: 'food', format: 'hybrid', online_url: 'https://meet.example/x', organization_id: null, city: 'Thohoyandou', country: 'South Africa', venue: 'The Roof', address: '1 Main Rd', lat: -22.95, lng: 30.48, profiles: { ...other, id: ME, username: 'mashao', display_name: 'Mashao McCoy Lebepe' }, ...x })
const CATS = [{ slug: 'concerts', label: 'Concerts & gigs', group_key: 'concerts', sort: 10, active: true }, { slug: 'food', label: 'Food & lifestyle', group_key: 'events', sort: 20, active: true }, { slug: 'arts-culture', label: 'Arts & culture', group_key: 'events', sort: 30, active: true }]
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

async function open({ width = 390, height = 844, url = '/app/discover', event = EVENT(), manage = true, admin = false, tiles = [], maps = { configured: false }, reduced = false, events = [card(1), card(2, { format: 'in_person', category: 'concerts', category_label: 'Concerts & gigs', going: 0 })], social } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference', colorScheme: 'dark' })
  const seen = { patches: [], uploads: [], upserts: [], deletes: [], removed: [], google: [], discover: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); sessionStorage.setItem('vybe:discover-fresh', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://maps.googleapis.com/**', route => { seen.google.push(route.request().url()); return route.abort() })
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (u.pathname === '/functions/v1/maps') return json(maps)
    if (u.pathname.startsWith('/storage/v1/object/sign')) return json({ signedURL: `/object/sign/media/${u.pathname.split('/').pop()}?token=t` })
    if (u.pathname.startsWith('/storage/v1/object/') && r.method() === 'POST') { seen.uploads.push(u.pathname); return json({ Key: 'ok' }) }
    if (u.pathname.startsWith('/storage/v1/object/') && r.method() === 'DELETE') { seen.removed.push(r.postData()); return json([]) }
    if (u.pathname.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const rpc = u.pathname.replace('/rest/v1/rpc/', '')
      if (rpc === 'discover_events') { seen.discover.push(JSON.parse(r.postData() ?? '{}')); return json(events) }
      if (rpc === 'discover_orgs') return json([])
      if (rpc === 'discover_live') return json([])
      if (rpc === 'event_social') return json(social ?? { going: 14, interested: 3, saved: false, mine: null, people: [{ id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, status: 'going', friend: true }] })
      if (rpc === 'can_manage_event') return json(manage)
      if (rpc === 'is_admin') return json(admin)
      if (rpc === 'is_staff') return json(admin)
      if (rpc === 'home_hero_settings') return json({ trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 })
      if (rpc === 'trending_events') return json([])
      return json(null)
    }
    const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)
    if (m) {
      const t = m[1]
      if (r.method() === 'PATCH' && t === 'events') { seen.patches.push(JSON.parse(r.postData() ?? '{}')); return route.fulfill({ status: 204, headers: h, body: '' }) }
      if (r.method() === 'POST' && t === 'discover_tiles') { seen.upserts.push({ body: JSON.parse(r.postData() ?? '{}'), prefer: r.headers().prefer }); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (r.method() === 'DELETE' && t === 'discover_tiles') { seen.deletes.push(u.search); return route.fulfill({ status: 204, headers: h, body: '' }) }
      const rows = { profiles: [me], events: [event], event_categories: CATS, discover_tiles: tiles, event_rsvps: [], follows: [], communities: [], community_members: [], friendships: [], ticket_types: [], event_lineup: [], live_streams: [], organizations: [], staff: admin ? [{ user_id: ME, role: 'admin' }] : [] }[t] ?? []
      return json(obj ? (rows[0] ?? null) : rows)
    }
    return json([])
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + url); await page.waitForTimeout(1000)
  return { page, ctx, seen, errs }
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)

/* ---------------------------------------------------------------- event page */
let t = await open({ url: '/app/plans/e1' })
await shot(t.page, 'event-no-cover')
const hero = await t.page.evaluate(() => { const h = document.querySelector('.ev-hero')?.getBoundingClientRect(); return { top: Math.round(h?.top ?? -1), height: Math.round(h?.height ?? 0), hdr: getComputedStyle(document.querySelector('.hdr')).display, vh: innerHeight } })
check('event page: header artwork starts at the very top on phones (app bar steps aside) and fills most of the screen', hero.top === 0 && hero.hdr === 'none' && hero.height >= hero.vh * 0.6, JSON.stringify(hero))
check('event page without a cover: a clear "Add a cover photo or video" call for its editors', await t.page.getByRole('button', { name: 'Add a cover photo or video' }).isVisible())
check('event page: going is a count ("14 going · 3 interested"), not a list of people', await t.page.getByRole('button', { name: /^14 going, 3 interested/ }).isVisible() && await t.page.locator('.list a[href^="/app/u/"]').count() === 0)
await t.page.getByRole('button', { name: /^14 going, 3 interested/ }).click(); await t.page.waitForTimeout(300)
check('tapping the count opens who’s going, with private attendance counted, not named', await t.page.getByRole('dialog', { name: 'Who’s going' }).isVisible() && await t.page.getByRole('link', { name: /Bob/ }).isVisible() && await t.page.getByText('13 people keep this private or share it only with their friends.').isVisible())
await shot(t.page, 'event-whos-going')
await t.page.getByRole('tab', { name: '3 interested' }).click(); await t.page.waitForTimeout(200)
check('the interested tab counts people without exposing them', await t.page.getByText('3 people keep this private or share it only with their friends.').isVisible())
await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(200)
await t.page.getByRole('button', { name: 'Change the cover photo and background video' }).click(); await t.page.waitForTimeout(300)
check('editors get one "Event look" sheet for the cover photo and the background video', await t.page.getByRole('dialog', { name: 'Event look' }).isVisible() && await t.page.getByRole('button', { name: 'Upload photo' }).isVisible() && await t.page.getByRole('button', { name: 'Upload video' }).isVisible())
await shot(t.page, 'event-look-sheet')
const [chooser] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.getByRole('button', { name: 'Upload photo' }).click()])
await chooser.setFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG }); await t.page.waitForTimeout(900)
check('uploading a cover stores it in the member’s own folder, then saves it on the event', t.seen.uploads.some(p => p.startsWith(`/storage/v1/object/media/${ME}/`)) && t.seen.patches.some(p => typeof p.cover_path === 'string' && p.cover_path.startsWith(`${ME}/`)), JSON.stringify([t.seen.uploads, t.seen.patches]))
const [vchooser] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.getByRole('button', { name: 'Upload video' }).click()])
await vchooser.setFiles({ name: 'loop.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }); await t.page.waitForTimeout(300)
check('a non-video file for the background is refused with a plain message', await t.page.getByText('Choose a video (MP4, WebM or MOV).').isVisible() && !t.seen.patches.some(p => 'hero_video_path' in p))
const [v2] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.getByRole('button', { name: 'Upload video' }).click()])
await v2.setFiles({ name: 'loop.mp4', mimeType: 'video/mp4', buffer: Buffer.from('fake mp4 bytes') }); await t.page.waitForTimeout(900)
check('a background video is uploaded and saved as hero_video_path', t.seen.patches.some(p => typeof p.hero_video_path === 'string' && p.hero_video_path.endsWith('.mp4')))
check('no page errors on the event page', t.errs.length === 0, t.errs.join(' | '))
await t.ctx.close()

t = await open({ url: '/app/plans/e1', manage: false, event: EVENT({ host: OTHER, cover_path: `${OTHER}/cover.png`, hero_video_path: `${OTHER}/loop.mp4` }) })
await shot(t.page, 'event-with-media')
check('with media: the cover fills the header and the background video loops muted over it', await t.page.locator('.ev-hero.has-media .ev-hero-media img').count() === 1 && await t.page.locator('.ev-hero-media video[autoplay][loop]').evaluate(v => v.muted) === true)
check('people who cannot edit the event see no editing controls', await t.page.getByRole('button', { name: /Change the cover/ }).count() === 0 && await t.page.getByRole('button', { name: 'Add a cover photo or video' }).count() === 0)
check('Tickets and Save buttons are large and side by side', await t.page.evaluate(() => { const b = [...document.querySelectorAll('.ev-hero-actions .btn')].map(x => x.getBoundingClientRect()); return b.length === 2 && Math.abs(b[0].top - b[1].top) < 2 && b[0].height >= 50 }))
check('event page has no horizontal overflow', await noOverflow(t.page))
await t.ctx.close()

t = await open({ url: '/app/plans/e1', reduced: true, manage: false, event: EVENT({ host: OTHER, cover_path: `${OTHER}/cover.png`, hero_video_path: `${OTHER}/loop.mp4` }) })
check('reduced motion: the still cover is shown instead of the moving video', await t.page.locator('.ev-hero-media video').count() === 0 && await t.page.locator('.ev-hero-media img').count() === 1)
await t.ctx.close()

/* ---------------------------------------------------------------- Discover rail */
t = await open({ tiles: [{ id: 'music', media_path: 'discover/11111111-1111-4111-8111-111111111111.webp' }] })
await shot(t.page, 'discover-rail')
const tx = () => t.page.locator('.crail-track').evaluate(el => -new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)
const s0 = await tx()
await t.page.waitForTimeout(1500)
const s1 = await tx()
check('the category rail glides to the left on its own', s1 > s0 + 10, `${s0} → ${s1}`)
await t.page.locator('.crail-view').hover(); await t.page.waitForTimeout(200)
const h0 = await tx(); await t.page.waitForTimeout(900)
check('hovering (or touching) the rail stops the motion so it can be used', Math.abs((await tx()) - h0) <= 1)
check('the looping copy of the tiles is hidden from screen readers and the keyboard', await t.page.locator('.crail-item[aria-hidden="true"][tabindex="-1"]').count() === await t.page.getByRole('navigation', { name: 'Explore categories' }).getByRole('link').count())
check('an admin-chosen cover is used for its tile (public brand file)', await t.page.locator('.crail-tile.has-art').first().evaluate(el => getComputedStyle(el).backgroundImage.includes('/storage/v1/object/public/brand/discover/')))
const labels = await t.page.locator('.crail-item:not([aria-hidden]) .crail-label').evaluateAll(els => els.map(el => {
  const lh = parseFloat(getComputedStyle(el).lineHeight), lines = Math.round(el.getBoundingClientRect().height / lh)
  const range = document.createRange(); range.selectNodeContents(el)
  const tops = new Set([...range.getClientRects()].map(r => Math.round(r.top)))
  const words = el.textContent.split(/\s+/)
  const broken = words.some(w => { const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit;font-weight:800'; probe.textContent = w; el.appendChild(probe); const wide = probe.getBoundingClientRect().width > el.clientWidth + 1; probe.remove(); return wide })
  return { text: el.textContent, lines, rows: tops.size, broken, cut: el.scrollHeight > el.clientHeight + 1, hy: getComputedStyle(el).hyphens }
}))
check('tile labels fit on at most two lines, never cut and never broken inside a word', labels.every(l => l.lines <= 2 && !l.cut && !l.broken && l.hy !== 'auto'), JSON.stringify(labels.filter(l => l.lines > 2 || l.cut || l.broken)))
const size = await t.page.locator('.crail-tile').first().evaluate(el => ({ w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }))
check('tiles are taller than they are wide (portrait cards)', size.h >= 170 && size.h > size.w * 1.25, JSON.stringify(size))
check('Discover does not pre-open a category list under the rail', await t.page.locator('.rv-bar').count() === 0 && await t.page.getByRole('button', { name: /^Filters/ }).count() === 0)
check('poster cards show "14 going" as a number, not friends’ names', await t.page.locator('.poster .pc-meta >> text=going').first().textContent().then(x => x?.includes('14 going')) && await t.page.getByText('Bob +1 going').count() === 0)
const pill = await t.page.locator('.pill-fmt').first().evaluate(el => { const a = el.getBoundingClientRect(), c = el.closest('.poster-art').getBoundingClientRect(); return { inside: a.right <= c.right + 0.5 && a.left >= c.left, oneLine: a.height < 30 } })
check('the Hybrid label sits fully inside the card on one line', pill.inside && pill.oneLine, JSON.stringify(pill))
check('no page errors on Discover', t.errs.length === 0, t.errs.join(' | '))
await t.page.locator('.crail-view').hover(); await t.page.getByRole('navigation', { name: 'Explore categories' }).getByRole('link', { name: 'Food & lifestyle', exact: true }).click(); await t.page.waitForTimeout(900)
await shot(t.page, 'category-screen')
check('a tile opens a clean category screen: cover band, title, search, place, when, Filters and Map', new URL(t.page.url()).pathname === '/app/discover/c/food' && await t.page.getByRole('heading', { name: 'Food & lifestyle', level: 1 }).isVisible() && await t.page.getByRole('group', { name: 'When' }).isVisible() && await t.page.getByRole('button', { name: /^Filters/ }).isVisible() && await t.page.getByRole('button', { name: 'Map', exact: true }).isVisible() && await t.page.locator('.dloc').isVisible())
check('the category screen asks the server for that category only', (t.seen.discover.at(-1).p_categories ?? []).join() === 'food', JSON.stringify(t.seen.discover.at(-1)))
check('category filters are tucked into a sheet (no long filter panel on the page)', await t.page.locator('.rv-sheet').count() === 0)
await t.page.getByRole('button', { name: /^Filters/ }).click(); await t.page.waitForTimeout(200)
await shot(t.page, 'category-filters')
await t.page.getByRole('button', { name: 'Paid', exact: true }).click(); await t.page.getByRole('button', { name: /^Show \d+/ }).click(); await t.page.waitForTimeout(400)
check('filters apply on the server and show as a count on the Filters button', t.seen.discover.at(-1).p_free === false && /Filters\s*1/.test(await t.page.getByRole('button', { name: /^Filters/ }).textContent() ?? ''), JSON.stringify([t.seen.discover.at(-1), await t.page.getByRole('button', { name: /^Filters/ }).textContent()]))
await t.page.getByRole('button', { name: 'Map', exact: true }).click(); await t.page.waitForTimeout(600)
await shot(t.page, 'map-brand')
const mp = await t.page.evaluate(() => { const d = document.querySelector('.dmap')?.getBoundingClientRect(); return { full: d && d.top === 0 && d.height >= innerHeight - 1 && d.width >= innerWidth - 1, nav: getComputedStyle(document.querySelector('.bottomnav')).display } })
check('the map is full screen and the tab bar steps aside', mp.full && mp.nav === 'none', JSON.stringify(mp))
check('every plan with a location has a pin and a card', await t.page.locator('.dmap-pin').count() === 2 && await t.page.locator('.dmap-card').count() === 2)
await t.page.getByRole('button', { name: /^B: / }).click(); await t.page.waitForTimeout(700)
check('choosing a pin brings its card forward', await t.page.locator('.dmap-card').nth(1).evaluate(el => el.classList.contains('on')) && await t.page.getByRole('button', { name: /^B: / }).getAttribute('aria-pressed') === 'true')
const dir = await t.page.getByRole('link', { name: /Directions to/ }).first().getAttribute('href')
check('cards offer directions through a plain Google Maps link (no key)', /^https:\/\/www\.google\.com\/maps\/dir\//.test(dir ?? '') && !/key=/.test(dir ?? ''))
check('no Google script is requested without a browser key', t.seen.google.length === 0)
await t.page.getByRole('button', { name: 'Close the map' }).click(); await t.page.waitForTimeout(300)
check('closing the map brings the tab bar back', await t.page.evaluate(() => getComputedStyle(document.querySelector('.bottomnav')).display) !== 'none')
await t.ctx.close()

t = await open({ reduced: true })
const r0 = await t.page.locator('.crail-list').evaluate(el => el.scrollLeft); await t.page.waitForTimeout(1200)
check('reduced motion: the rail stays still and has no hidden copies', (await t.page.locator('.crail-list').evaluate(el => el.scrollLeft)) === r0 && await t.page.locator('.crail-tile[aria-hidden="true"]').count() === 0)
await t.ctx.close()

t = await open({ url: '/app/discover/c/food', maps: { configured: true, browser_key: 'AIzaSyBrowserKeyRestrictedToVybe00000' } })
await t.page.getByRole('button', { name: 'Map', exact: true }).click(); await t.page.waitForTimeout(1500)
check('with a browser key the map asks Google for its script only when opened', t.seen.google.length === 1 && t.seen.google[0].startsWith('https://maps.googleapis.com/maps/api/js?key=AIzaSyBrowserKeyRestrictedToVybe00000'))
check('if Google cannot load, the VYBE plan view takes over (never a blank screen)', await t.page.locator('.dmap-brand').count() === 1 && await t.page.getByText(/Google Maps could not load/).isVisible())
await t.ctx.close()

/* ---------------------------------------------------------------- admin tile covers */
t = await open({ url: '/admin/discover', admin: true })
await shot(t.page, 'admin-tile-covers')
check('admins see a cover control for every category tile', await t.page.getByRole('heading', { name: 'Category tile covers' }).isVisible() && await t.page.locator('.tile-admin-row').count() === 9)
const row = t.page.locator('.tile-admin-row', { hasText: 'Concerts & music' })
const [ac] = await Promise.all([t.page.waitForEvent('filechooser'), row.getByRole('button', { name: 'Upload' }).click()])
await ac.setFiles({ name: 'tile.webp', mimeType: 'image/webp', buffer: PNG }); await t.page.waitForTimeout(900)
check('a tile cover goes to the brand bucket’s discover/ folder and is saved for that tile', t.seen.uploads.some(p => /^\/storage\/v1\/object\/brand\/discover\/[0-9a-f-]{36}\.webp$/.test(p)) && t.seen.upserts.some(u => u.body.id === 'music' && /^discover\/[0-9a-f-]{36}\.webp$/.test(u.body.media_path) && /merge-duplicates/.test(u.prefer ?? '')), JSON.stringify([t.seen.uploads, t.seen.upserts]))
const [bad] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.locator('.tile-admin-row', { hasText: 'Online' }).getByRole('button', { name: 'Upload' }).click()])
await bad.setFiles({ name: 'x.gif', mimeType: 'image/gif', buffer: PNG }); await t.page.waitForTimeout(300)
check('unsupported files are refused before upload', await t.page.getByText('Use a JPG, PNG or WebP picture, or an MP4 or WebM video.').isVisible())
await t.ctx.close()

for (const [w, h] of [[360, 740], [390, 844], [768, 1024], [1280, 800]]) {
  for (const url of ['/app/discover', '/app/discover/c/food', '/app/plans/e1']) {
    const x = await open({ width: w, height: h, url })
    check(`${url} has no horizontal overflow at ${w}×${h}`, await noOverflow(x.page))
    await x.ctx.close()
  }
}
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall round 4 checks passed')
process.exit(failures ? 1 : 0)
