// Browser checks for suggestions in the Home feed (events, artists, people) against a MOCKED backend: where the rails sit,
// what each card says, the data sent by Save / Follow / Not interested, the place passed for distance, and that other tabs,
// an empty feed and an older server behave. SHOTS=<dir> also saves phone and desktop screenshots.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = Date.now()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(now / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(now / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null, onboarded_at: new Date(now).toISOString(), interests: ['Music'] }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }
const post = i => ({ id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`, author: OTHER, body: `Post number ${i}`, media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: new Date(now - i * 60e3).toISOString(), edited_at: null, profiles: other, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], tags: [], post_media: [] })
const uuid = (p, i) => `${p}000000-0000-4000-8000-00000000000${i}`
const SUGG = {
  events: [
    { id: uuid('e1', 1), title: 'Rooftop Sessions', starts_at: new Date(now + 3 * 864e5).toISOString(), timezone: 'Africa/Johannesburg', city: 'Cape Town', venue: 'The Roof', cover_path: null, format: 'in_person', category_label: 'Concerts & gigs', distance_km: 2.1, going: 41, friends_going: 2, reason: { code: 'friends_going', n: 2 } },
    { id: uuid('e1', 2), title: 'Jazz on the Lawn', starts_at: new Date(now + 9 * 864e5).toISOString(), timezone: 'Africa/Johannesburg', city: 'Stellenbosch', venue: null, cover_path: null, format: 'in_person', category_label: 'Festivals', distance_km: 38, going: 3, friends_going: 0, reason: { code: 'your_interests', label: 'Festivals' } },
  ],
  artists: [{ id: uuid('a1', 1), name: 'The Night Owls', slug: 'night-owls', kind: 'artist', avatar_path: null, verified: true, followers: 120, upcoming: 2, reason: { code: 'plays_your_event', label: 'Rooftop Sessions' } }],
  people: [
    { id: uuid('c1', 1), username: 'carol', display_name: 'Carol', avatar_path: null, verified_until: null, reason: { code: 'mutual_friends', n: 3 } },
    { id: uuid('c1', 2), username: 'dan', display_name: 'Dan', avatar_path: null, verified_until: null, reason: { code: 'shared_interests', label: 'Music & Art' } },
  ],
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open({ posts = 15, width = 390, height = 844, noRpc = false, place = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } })
  const seen = { sugg: [], dismiss: [], follows: [], saves: [] }
  await ctx.addInitScript(([s, place]) => {
    try {
      sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s)
      if (place) localStorage.setItem('vybe:place', JSON.stringify({ name: 'Cape Town', country: 'ZA', lat: -33.92, lng: 18.42 }))
    } catch {}
  }, [JSON.stringify(session), place])
  const list = Array.from({ length: posts }, (_, i) => post(i + 1))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    if (u.pathname === '/rest/v1/rpc/feed_suggestions') { seen.sugg.push(body()); return noRpc ? json({ code: 'PGRST202', message: 'Could not find the function public.feed_suggestions in the schema cache' }, 404) : json(SUGG) }
    if (u.pathname === '/rest/v1/rpc/dismiss_suggestion') { seen.dismiss.push(body()); return json(null) }
    if (u.pathname === '/rest/v1/follows' && r.method() === 'POST') { seen.follows.push(body()); return route.fulfill({ status: 201, headers: h, body: '' }) }
    if (u.pathname === '/rest/v1/event_saves' && r.method() === 'POST') { seen.saves.push(body()); return route.fulfill({ status: 201, headers: h, body: '' }) }
    if (u.pathname === '/rest/v1/rpc/my_profile') return json(me)
    if (u.pathname === '/rest/v1/profiles') return json(obj ? me : [me])
    if (u.pathname === '/rest/v1/posts' && r.method() === 'GET') return json(u.searchParams.get('is_reel') || u.searchParams.has('or') || u.searchParams.has('created_at') || u.searchParams.has('author') ? [] : list)
    return json(obj ? null : [])
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${BASE}/app`)
  await page.waitForSelector('.igp', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1200)
  return { ctx, page, seen, errors }
}
// Index of the post each rail follows (0-based), read from the page order.
const order = page => page.evaluate(() => {
  const out = []; let posts = -1
  for (const el of document.querySelectorAll('.igp, .sg')) { if (el.classList.contains('sg')) out.push({ title: el.getAttribute('aria-label'), after: posts }); else posts++ }
  return out
})

// 1. A full page of posts: rails after the 3rd, 8th and 13th.
{
  const t = await open()
  const o = await order(t.page)
  check('three rails sit between posts: events after the 3rd, artists after the 8th, people after the 13th',
    JSON.stringify(o) === JSON.stringify([{ title: 'Events for you', after: 2 }, { title: 'Artists you might like', after: 7 }, { title: 'People you may know', after: 12 }]), JSON.stringify(o))
  check('the request carries the member\'s place (for distance) and asks for a bounded number', t.seen.sugg[0]?.p_lat === -33.92 && t.seen.sugg[0]?.p_lng === 18.42 && t.seen.sugg[0]?.p_limit === 10, JSON.stringify(t.seen.sugg))
  const text = await t.page.locator('.sg').allInnerTexts()
  check('each card says why it is there', text[0].includes('2 friends going') && text[0].includes('Matches your interests') && text[1].includes('Playing Rooftop Sessions') && text[2].includes('3 mutual friends') && text[2].includes('Into Music & Art'), JSON.stringify(text))
  if (process.env.SHOTS) { await t.page.locator('.sg').first().scrollIntoViewIfNeeded(); await t.page.screenshot({ path: `${process.env.SHOTS}/sugg-events-phone.png` }); await t.page.locator('.sg').nth(2).scrollIntoViewIfNeeded(); await t.page.screenshot({ path: `${process.env.SHOTS}/sugg-people-phone.png` }) }

  // Save, Follow, Not interested.
  await t.page.locator('.sg').first().getByRole('button', { name: 'Save' }).first().click(); await t.page.waitForTimeout(400)
  check('Save on an event saves it to the member\'s plans', t.seen.saves.length === 1 && t.seen.saves[0].event_id === SUGG.events[0].id && t.seen.saves[0].user_id === ME, JSON.stringify(t.seen.saves))
  await t.page.locator('.sg').nth(1).getByRole('button', { name: /Follow The Night Owls/ }).click(); await t.page.waitForTimeout(400)
  await t.page.locator('.sg').nth(2).getByRole('button', { name: /Follow Carol/ }).click(); await t.page.waitForTimeout(400)
  check('Follow on an artist and on a person writes the right follow', t.seen.follows.some(f => f.target_type === 'organization' && f.target_id === SUGG.artists[0].id && f.follower === ME) && t.seen.follows.some(f => f.target_type === 'profile' && f.target_id === SUGG.people[0].id), JSON.stringify(t.seen.follows))
  await t.page.locator('.sg').first().getByRole('button', { name: 'Not interested' }).nth(1).click(); await t.page.waitForTimeout(400)
  const left = await t.page.locator('.sg').first().locator('.sg-card').count()
  check('Not interested removes the card and is remembered on the server', left === 1 && t.seen.dismiss.length === 1 && t.seen.dismiss[0].p_kind === 'event' && t.seen.dismiss[0].p_target === SUGG.events[1].id, JSON.stringify({ left, d: t.seen.dismiss }))
  await t.page.locator('.sg').nth(2).getByRole('button', { name: 'Not interested' }).first().click()
  await t.page.locator('.sg').nth(2).getByRole('button', { name: 'Not interested' }).first().click(); await t.page.waitForTimeout(400)
  check('dismissing every card in a rail removes the rail', await t.page.locator('.sg').count() === 2 && t.seen.dismiss.filter(d => d.p_kind === 'profile').length === 2)
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))

  // Other tabs: no suggestions.
  await t.page.getByRole('tab', { name: 'Friends' }).click(); await t.page.waitForTimeout(800)
  check('the Friends tab shows no suggestions', await t.page.locator('.sg').count() === 0)
  await t.ctx.close()
}

// 2. A short feed: all rails after the last post.
{
  const t = await open({ posts: 4 })
  const o = await order(t.page)
  check('a short feed: events after the 3rd post, artists and people at the end', JSON.stringify(o.map(x => x.after)) === JSON.stringify([2, 3, 3]), JSON.stringify(o))
  await t.ctx.close()
}

// 3. An empty feed: the suggestions are the way in.
{
  const t = await open({ posts: 0 })
  const rails = await t.page.locator('.sg').count()
  const emptyShown = await t.page.getByText('Nothing here yet').count()
  check('an empty feed shows its empty state and then all three rails', emptyShown === 1 && rails === 3, JSON.stringify({ emptyShown, rails }))
  await t.ctx.close()
}

// 4. No place known; an older server.
{
  const t = await open({ place: false })
  check('without a place, no location is sent', t.seen.sugg[0] && t.seen.sugg[0].p_lat === null && t.seen.sugg[0].p_lng === null, JSON.stringify(t.seen.sugg))
  await t.ctx.close()
  const old = await open({ noRpc: true })
  check('older server (no suggestions yet): the feed is unchanged and nothing breaks', await old.page.locator('.sg').count() === 0 && await old.page.locator('.igp').count() === 15 && old.errors.length === 0, old.errors.join(' | '))
  await old.ctx.close()
}

// 5. Desktop layout.
if (process.env.SHOTS) {
  const t = await open({ width: 1280, height: 900 })
  await t.page.locator('.sg').first().scrollIntoViewIfNeeded(); await t.page.waitForTimeout(300)
  await t.page.screenshot({ path: `${process.env.SHOTS}/sugg-desktop.png` })
  await t.ctx.close()
}

await browser.close()
if (failures) { console.log(`round8-check: ${failures} check(s) failed`); process.exit(1) }
console.log('round8-check: all round 8 checks passed')
