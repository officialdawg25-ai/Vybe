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
  const seen = { discover: [], follows: [], mapsOps: [], mapsUrls: [], rsvp: [] }
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
      return json(rpc === 'trending_events' ? [] : null)
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
check('Discover opens on "For you" with the mode selector', await t.page.getByRole('heading', { name: 'Discover', level: 1 }).isVisible() && (await t.page.locator('.shz-mode').textContent())?.includes('For you'))
check('poster tile shows friends going, LIVE and following context', await t.page.locator('.poster-friends').count() > 0 && await t.page.locator('.pill-live').count() > 0 && (await t.page.locator('.poster-foot').first().textContent())?.includes('Following'))
check('"All locations" and "Near me" controls are present', await t.page.getByRole('button', { name: /All locations/ }).isVisible() && await t.page.getByRole('button', { name: /Near me/ }).isVisible())
await t.page.getByRole('button', { name: 'Choose what to explore' }).click()
for (const label of ['For you', 'Concerts & shows', 'Events', 'Artists & venues', 'Communities', 'Live events']) check(`mode menu lists "${label}"`, await t.page.getByRole('menuitem', { name: label, exact: true }).count() === 1)
await t.page.getByRole('menuitem', { name: 'Concerts & shows' }).click(); await t.page.waitForTimeout(500)
check('Concerts mode queries the concerts group on the server', t.seen.discover.some(a => a.p_group === 'concerts'))
await t.page.getByRole('button', { name: 'Comedy' }).click(); await t.page.waitForTimeout(500)
check('category chip is sent as a server filter', t.seen.discover.some(a => (a.p_categories ?? []).includes('comedy')))
await t.page.getByRole('button', { name: 'Free', exact: true }).click(); await t.page.waitForTimeout(400)
check('price filter is sent as a server filter', t.seen.discover.some(a => a.p_free === true))
await t.page.getByRole('button', { name: 'All locations' }).click(); await t.page.waitForTimeout(400)
check('"All locations" drops the geographic filter', t.seen.discover.at(-1).p_lat === null)
await t.page.getByRole('button', { name: 'Map', exact: true }).click(); await t.page.waitForTimeout(500)
check('map view without a Google key shows a clear message and still lists events', (await t.page.getByText("The map isn’t available right now").count()) === 1 && await t.page.locator('.poster').count() > 0)
check('no page errors in Discover', t.errs.length === 0, t.errs.join(' | '))
await t.page.getByRole('button', { name: 'Choose what to explore' }).click()
await t.page.getByRole('menuitem', { name: 'Artists & venues' }).click(); await t.page.waitForTimeout(500)
await t.page.getByRole('button', { name: /Follow Local Band/ }).click(); await t.page.waitForTimeout(400)
check('Follow persists through the follows table with the member as follower', t.seen.follows.length === 1 && t.seen.follows[0].follower === ME && t.seen.follows[0].target_type === 'organization' && t.seen.follows[0].target_id === 'o1', JSON.stringify(t.seen.follows))
check('button reflects the persisted state', (await t.page.getByRole('button', { name: /Unfollow Local Band/ }).count()) === 1)
await t.page.getByRole('button', { name: 'Choose what to explore' }).click()
await t.page.getByRole('menuitem', { name: 'Live events' }).click(); await t.page.waitForTimeout(500)
check('Live mode lists event-related broadcasts with LIVE only for live ones', (await t.page.locator('.live-row .pill-live').count()) === 1 && await t.page.getByRole('link', { name: 'Watch now' }).isVisible())
await t.ctx.close()

t = await open({ maps: true, url: '/app/discover?mode=concerts' })
await t.page.getByRole('button', { name: 'Map', exact: true }).click(); await t.page.waitForTimeout(600)
check('with maps configured the map preview image renders', await t.page.locator('img.map-img').count() === 1)
check('the Google key never appears in any request URL the browser makes', t.seen.mapsUrls.every(u => !/key=|AIza/i.test(u)))
await t.ctx.close()

t = await open({ url: '/app/plans/e1', maps: true })
check('event page: artwork hero with category eyebrow, Tickets and Save', (await t.page.locator('.ev-eyebrow').textContent())?.includes('UPCOMING CONCERTS') && await t.page.getByRole('button', { name: 'Tickets' }).isVisible() && await t.page.getByRole('button', { name: /Save/ }).isVisible())
check('event page: guide card with start time, venue and directions', (await t.page.locator('.guide').first().textContent())?.includes('Starts at') && await t.page.getByRole('link', { name: 'Open directions in Google Maps' }).isVisible())
const href = await t.page.getByRole('link', { name: 'Open directions in Google Maps' }).getAttribute('href')
check('directions link is a plain Google Maps URL without any API key', /^https:\/\/www\.google\.com\/maps\/dir\//.test(href ?? '') && !/key=/.test(href ?? ''))
check('event page: follow buttons for host and presenting page', await t.page.getByRole('button', { name: /Follow Bob/ }).isVisible() && await t.page.getByRole('button', { name: /Follow Local Band/ }).isVisible())
check('event page: Interested, Going and Save are separate controls', await t.page.getByRole('button', { name: 'Interested' }).isVisible() && await t.page.getByRole('button', { name: 'Going', exact: true }).isVisible())
await t.page.getByRole('button', { name: 'Interested' }).click(); await t.page.waitForTimeout(400)
check('Interested saves status "maybe" (not going)', t.seen.rsvp.length === 1 && t.seen.rsvp[0].status === 'maybe' && t.seen.rsvp[0].user_id === ME, JSON.stringify(t.seen.rsvp))
check('attendance counts come from the aggregate (12 going · 3 interested)', await t.page.getByText('12 going · 3 interested').isVisible())
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

t = await open({ events: [], url: '/app/discover?mode=events' })
check('empty state offers useful next steps instead of a blank screen', await t.page.getByText(/No events match/).isVisible() && await t.page.getByRole('link', { name: 'Host one' }).isVisible())
await t.ctx.close()

for (const [w, h] of [[375, 667], [768, 1024], [1280, 800]]) {
  const x = await open({ width: w, height: h })
  check(`Discover has no horizontal overflow at ${w}×${h}`, !(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
  await x.ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall discover checks passed')
process.exit(failures ? 1 : 0)
