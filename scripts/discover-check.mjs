// Browser checks for the Discover upgrade against a MOCKED backend: mode selector, filters call the server with the right
// arguments, friends/LIVE/following context renders, follow persists, maps degrade gracefully (and never expose a key),
// event page actions, direct links, and that individual live streams are not part of Discover's live section.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5 * 3).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const card = (n, extra = {}) => ({ id: `e${n}`, title: `Gig ${n}`, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', city: 'Cape Town', venue: 'Clifton', location: null, cover_path: null, category: 'concerts', category_label: 'Concerts & gigs', format: 'in_person', lat: -33.9, lng: 18.4, distance_km: 4, source: 'vybe', source_name: null, price_from_cents: 15000, price_cents: 15000, currency: 'ZAR', has_tickets: true, going: 12, friends_going: 0, friend_avatars: [], followed: false, live: false, artists: [], host: other, org: null, ...extra })
const EVENT = { id: 'e1', host: OTHER, title: 'Gig 1', description: 'Bring friends', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: null, visibility: 'public', capacity: null, community_id: null, price_cents: 15000, currency: 'ZAR', ticket_url: null, status: 'active', category: 'concerts', format: 'in_person', online_url: null, organization_id: 'o1', city: 'Cape Town', country: 'South Africa', venue: 'The Roof', address: '1 Long St', lat: -33.92, lng: 18.42, profiles: other }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

async function open({ width = 375, height = 760, url = '/app/discover', maps = false, events = [card(1, { friends_going: 2, friend_avatars: [{ username: 'bob', display_name: 'Bob', avatar_path: null }], live: true, followed: true })], social = null, status = 'active', follows = [] }) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const seen = { discover: [], follows: [], mapsOps: [], mapsUrls: [], rsvp: [], trending: 0 }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200, extra = {}) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b), ...extra })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const rpc = u.pathname.replace('/rest/v1/rpc/', '')
    if (u.pathname === '/functions/v1/maps') {
      const b = JSON.parse(r.postData() ?? '{}'); seen.mapsOps.push(b.op); seen.mapsUrls.push(r.url())
      if (b.op === 'status') return json({ configured: maps })
      if (b.op === 'static') return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: PNG })
      if (b.op === 'route') return json({ distance_m: 15400, duration_s: 1260, mode: b.mode, polyline: null })
      return json({ results: [] })
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      if (rpc === 'discover_events') { const a = JSON.parse(r.postData() ?? '{}'); seen.discover.push(a); return json(events) }
      if (rpc === 'discover_orgs') return json([{ id: 'o1', name: 'Local Band', slug: 'local-band', kind: 'artist', description: 'Live', avatar_path: null, verified: false, followers: 3, upcoming: 1, following: false }])
      if (rpc === 'discover_live') return json([{ id: 's1', title: 'Gig 1 live', status: 'live', access: 'open', scheduled_for: later, started_at: now, viewers: 5, can_watch: true, host: 'Bob', org: null, event: { id: 'e1', title: 'Gig 1', city: 'Cape Town', venue: 'Clifton', cover_path: null, starts_at: later, timezone: 'UTC', format: 'in_person' } }])
      if (rpc === 'event_social') return json(social ?? { going: 12, interested: 3, saved: false, mine: null, people: [{ id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, status: 'going', friend: true }] })
      if (rpc === 'follow_stats') return json({ followers: 3, following: false })
      if (rpc === 'can_manage_event') return json(false)
      if (['home_hero_settings'].includes(rpc)) return json({ trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 })
      if (rpc === 'trending_events') { seen.trending++; return json([]) }
      return json(null)
    }
    const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)
    if (m) {
      const t = m[1]
      if (r.method() === 'POST' && t === 'follows') { seen.follows.push(JSON.parse(r.postData() ?? '{}')); return route.fulfill({ status: 201, headers: h, body: '' }) }
      if (r.method() === 'POST' && t === 'event_rsvps') { seen.rsvp.push(JSON.parse(r.postData() ?? '{}')); return route.fulfill({ status: 201, headers: h, body: '' }) }
      const rows = { profiles: [me], events: [{ ...EVENT, status }], organizations: [{ id: 'o1', name: 'Local Band', slug: 'local-band', kind: 'artist', description: 'Live', avatar_path: null, verified_at: null }], follows, event_categories: [{ slug: 'concerts', label: 'Concerts & gigs', group_key: 'concerts', sort: 10, active: true }, { slug: 'comedy', label: 'Comedy', group_key: 'concerts', sort: 30, active: true }], event_rsvps: [], communities: [], community_members: [], friendships: [], ticket_types: [], event_lineup: [], live_streams: [] }[t] ?? []
      return json(obj ? (rows[0] ?? null) : rows)
    }
    return json([])
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(e.message))
  await page.goto(BASE + url); await page.waitForTimeout(900)
  return { page, ctx, seen, errs }
}

let t = await open({})
check('Discover opens on "For you" with a visible search field', await t.page.getByRole('heading', { name: 'Discover', level: 1 }).isVisible() && await t.page.getByRole('searchbox', { name: 'Search' }).isVisible() && await t.page.getByRole('tab', { name: 'For you' }).getAttribute('aria-selected') === 'true')
check('poster tile shows LIVE and how many are going (a count, never a list of names)', await t.page.locator('.pill-live').count() > 0 && (await t.page.locator('.poster .poster-going').allTextContents()).some(x => x.includes('12 going')) && await t.page.locator('.poster-friends').count() === 0)
check('location is one compact control showing the place and radius', await t.page.locator('.dloc').count() === 1 && /km/.test(await t.page.locator('.dloc').textContent() ?? ''))
await t.page.locator('.dloc').click(); await t.page.waitForTimeout(300)
check('it opens a sheet with A place, Near me, All locations and the radius', await t.page.getByRole('button', { name: /All locations/ }).isVisible() && await t.page.getByRole('button', { name: /Near me/ }).isVisible() && await t.page.getByRole('group', { name: 'Search radius' }).isVisible())
await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(200)
const ui = await t.page.evaluate(() => { const h = document.querySelector('.hdr')?.getBoundingClientRect(), b = document.querySelector('.billboard')?.getBoundingClientRect(); return { gap: h && b ? Math.round(b.top - h.bottom) : null, height: b ? Math.round(b.height) : null } })
check('the Discover banner starts right under the header and is tall', ui.gap !== null && Math.abs(ui.gap) <= 1 && ui.height >= 230, JSON.stringify(ui))
check('event cards carry their details on the artwork (title, place, price inside the card)', await t.page.locator('.poster-art .poster-over .poster-title').count() > 0 && await t.page.locator('.poster-art .poster-foot').count() > 0)
check('pages are shown as picture cards in rails, not a vertical list', await t.page.locator('.org-rail .org-tile').count() > 0 && await t.page.locator('.org-list .org-row').count() === 0)
const rail = t.page.getByRole('navigation', { name: 'Explore categories' })
for (const label of ['Concerts & music', 'Things to do', 'Concerts & gigs', 'Comedy', 'Artists & venues', 'Communities', 'Live from events', 'Online']) check(`category rail has a "${label}" tile`, await rail.getByRole('link', { name: label, exact: true }).count() === 1)
check('no tile is pre-selected and there is no "All" tile', await rail.getByRole('link', { name: 'All', exact: true }).count() === 0 && await rail.locator('[aria-selected="true"], .crail-tile.on').count() === 0)
check('admin categories become tiles (from event_categories)', await rail.getByRole('link', { name: 'Comedy', exact: true }).count() === 1)
const box = await rail.locator('.crail-list').evaluate(el => ({ dir: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height }))
check('categories scroll sideways in one row (not a vertical list)', box.dir === 'auto' && box.sw > box.cw && box.h < 240, JSON.stringify(box))
check('the category row does not make the page scroll sideways', !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
check('tile art uses a real plan cover from one discover call (no cover => colour tile)', t.seen.discover.some(a => a.p_limit === 60) && await rail.locator('.crail-tile.has-art').count() === 0)
await rail.getByRole('link', { name: 'Concerts & music', exact: true }).click(); await t.page.waitForTimeout(700)
check('a tile opens its own category screen', new URL(t.page.url()).pathname === '/app/discover/c/music' && await t.page.getByRole('heading', { name: 'Concerts & music', level: 1 }).isVisible())
check('Concerts & music queries the concerts group on the server', t.seen.discover.some(a => a.p_group === 'concerts'))
await t.page.goto(BASE + '/app/discover/c/comedy'); await t.page.waitForTimeout(700)
check('a category screen is sent as a server filter', (t.seen.discover.at(-1).p_categories ?? []).includes('comedy'), JSON.stringify(t.seen.discover.at(-1)))
await t.page.getByRole('button', { name: /^Filters/ }).click(); await t.page.waitForTimeout(200)
await t.page.getByRole('button', { name: 'Free', exact: true }).click(); await t.page.waitForTimeout(400)
check('price filter (in the Filters sheet) is sent as a server filter', t.seen.discover.some(a => a.p_free === true))
await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(200)
await t.page.locator('.dloc').click(); await t.page.waitForTimeout(200)
await t.page.getByRole('button', { name: /All locations/ }).click(); await t.page.waitForTimeout(400)
check('"All locations" drops the geographic filter', t.seen.discover.at(-1).p_lat === null)
await t.page.goto(BASE + '/app/discover'); await t.page.waitForTimeout(700)
await t.page.getByRole('tab', { name: 'Nearby' }).click(); await t.page.waitForTimeout(400)
check('Nearby without a place asks for one instead of guessing', await t.page.getByText('Nearby needs a place').isVisible() && new URL(t.page.url()).searchParams.get('f') === 'nearby')
await t.page.getByRole('tab', { name: 'Following' }).click(); await t.page.waitForTimeout(500)
check('Following asks the server for followed events only', t.seen.discover.at(-1).p_followed === true)
await t.page.getByRole('tab', { name: 'Trending' }).click(); await t.page.waitForTimeout(500)
check('Trending uses the server trending score (trending_events)', t.seen.trending > 0 && await t.page.getByText(/Nothing is picking up this week|ranked by tickets sold/).count() + await t.page.getByText(/Nothing coming up/).count() > 0)
await t.page.goto(BASE + '/app/discover/c/online'); await t.page.waitForTimeout(700)
check('Online tile filters on format', t.seen.discover.at(-1).p_format === 'online')
await t.page.getByRole('button', { name: 'Map', exact: true }).click(); await t.page.waitForTimeout(600)
check('Map opens full screen; without a Google key it shows VYBE’s own plan of the area with pins and cards', await t.page.getByRole('dialog', { name: /Map/ }).isVisible() && await t.page.locator('.dmap-brand .dmap-pin').count() === 1 && await t.page.locator('.dmap-card').count() === 1 && await t.page.getByText(/street map appears once Google Maps is switched on/).isVisible())
await t.page.keyboard.press('Escape'); await t.page.waitForTimeout(300)
check('Escape closes the map and the results are still listed', await t.page.locator('.dmap').count() === 0 && await t.page.locator('.poster').count() > 0)
check('no page errors in Discover', t.errs.length === 0, t.errs.join(' | '))
await t.page.goto(BASE + '/app/discover/c/artists'); await t.page.waitForTimeout(700)
await t.page.getByRole('button', { name: /Follow Local Band/ }).click(); await t.page.waitForTimeout(400)
check('Follow persists through the follows table with the member as follower', t.seen.follows.length === 1 && t.seen.follows[0].follower === ME && t.seen.follows[0].target_type === 'organization' && t.seen.follows[0].target_id === 'o1', JSON.stringify(t.seen.follows))
check('button reflects the persisted state', (await t.page.getByRole('button', { name: /Unfollow Local Band/ }).count()) === 1)
await t.page.goto(BASE + '/app/discover/c/live'); await t.page.waitForTimeout(700)
check('Live tile lists event-related broadcasts with LIVE only for live ones', (await t.page.locator('.live-row .pill-live').count()) === 1 && await t.page.getByRole('link', { name: 'Watch now' }).isVisible())
await t.page.goBack().catch(() => {}); await t.page.waitForTimeout(300)
await t.ctx.close()

t = await open({ url: '/app/discover?cat=comedy&f=following' })
check('an old shared ?cat= link opens that category’s screen', new URL(t.page.url()).pathname === '/app/discover/c/comedy' && await t.page.getByRole('heading', { name: 'Comedy', level: 1 }).isVisible())
await t.ctx.close()

t = await open({ url: '/app/discover?mode=artists' })
check('old ?mode= links still land on the matching category', new URL(t.page.url()).pathname === '/app/discover/c/artists' && await t.page.getByRole('heading', { name: 'Artists & venues', level: 1 }).isVisible())
await t.ctx.close()

t = await open({ width: 1280, height: 800 })
check('desktop shows "More" and "Previous" category arrows', await t.page.getByRole('button', { name: 'More categories' }).isVisible() && await t.page.getByRole('button', { name: 'Previous categories' }).isVisible())
const x0 = await t.page.locator('.crail-list').evaluate(el => el.scrollLeft)
await t.page.getByRole('button', { name: 'More categories' }).click(); await t.page.waitForTimeout(700)
check('"More categories" moves the row', (await t.page.locator('.crail-list').evaluate(el => el.scrollLeft)) !== x0)
await t.ctx.close()

t = await open({ maps: true, url: '/app/discover/c/music' })
await t.page.getByRole('button', { name: 'Map', exact: true }).click(); await t.page.waitForTimeout(600)
check('with only the server key configured the map still opens (VYBE plan view)', await t.page.locator('.dmap-brand').count() === 1)
check('the Google server key never appears in any request URL the browser makes', t.seen.mapsUrls.every(u => !/key=|AIza/i.test(u)))
await t.ctx.close()

t = await open({ url: '/app/plans/e1', maps: true })
check('event page: artwork hero with category eyebrow, Tickets and Save', (await t.page.locator('.ev-eyebrow').textContent())?.includes('UPCOMING CONCERTS') && await t.page.getByRole('button', { name: 'Tickets' }).isVisible() && await t.page.getByRole('button', { name: /Save/ }).isVisible())
check('event page: guide card with start time, venue and directions', (await t.page.locator('.guide').first().textContent())?.includes('Starts at') && await t.page.getByRole('link', { name: 'Open directions in Google Maps' }).isVisible())
const href = await t.page.getByRole('link', { name: 'Open directions in Google Maps' }).getAttribute('href')
check('directions link is a plain Google Maps URL without any API key', /^https:\/\/www\.google\.com\/maps\/dir\//.test(href ?? '') && !/key=/.test(href ?? ''))
check('event page: follow buttons for host and presenting page', await t.page.getByRole('button', { name: /Follow Bob/ }).isVisible() && await t.page.getByRole('button', { name: /Follow Local Band/ }).isVisible())
check('event page: Interested, Going and Save are separate controls', await t.page.getByRole('button', { name: 'Interested', exact: true }).isVisible() && await t.page.getByRole('button', { name: 'Going', exact: true }).isVisible())
await t.page.getByRole('button', { name: 'Interested', exact: true }).click(); await t.page.waitForTimeout(400)
check('Interested saves status "maybe" (not going)', t.seen.rsvp.length === 1 && t.seen.rsvp[0].status === 'maybe' && t.seen.rsvp[0].user_id === ME, JSON.stringify(t.seen.rsvp))
check('attendance counts come from the aggregate (12 going · 3 interested)', await t.page.getByText('12 going · 3 interested').first().isVisible())
await t.page.getByRole('button', { name: 'Drive' }).click(); await t.page.waitForTimeout(500)
check('travel time shows the server-computed route, labelled as an estimate', await t.page.getByText(/21 min · 15 km/).isVisible() && await t.page.getByText(/Estimates change/).isVisible())
check('no horizontal overflow on the event page', !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
await t.ctx.close()

t = await open({ url: '/app/plans/e1', status: 'draft' })
check('draft events are labelled and not attendable', await t.page.getByText('Only you and your organisation’s editors can see this.').isVisible() && await t.page.getByRole('button', { name: 'Going', exact: true }).count() === 0)
await t.ctx.close()

t = await open({ url: '/app/plans/e1' })
check('maps unavailable on the event page: address and directions still shown, no map or route controls', await t.page.getByText('1 Long St').first().isVisible() && await t.page.locator('img.map-img').count() === 0 && await t.page.getByRole('button', { name: 'Drive' }).count() === 0)
await t.ctx.close()

t = await open({ events: [], url: '/app/discover/c/things' })
check('empty state offers useful next steps instead of a blank screen', await t.page.getByText(/No plans yet/).isVisible() && await t.page.getByRole('link', { name: 'Host one' }).isVisible())
await t.ctx.close()

for (const [w, h] of [[375, 667], [768, 1024], [1280, 800]]) {
  const x = await open({ width: w, height: h })
  check(`Discover has no horizontal overflow at ${w}×${h}`, !(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), await x.page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.crail-list,.hscroll,.dfilters,.rv-when')).slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).join(', ')))
  await x.ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall discover checks passed')
process.exit(failures ? 1 : 0)
