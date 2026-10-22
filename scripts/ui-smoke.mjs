// UI smoke test: boots the production build against a MOCKED Supabase HTTP API and visits every
// authenticated route, failing on runtime errors, horizontal overflow or axe violations.
// It validates rendering only. It does not exercise the real database, Realtime or Storage.
//
//   npx vite build --outDir dist-mock   (with VITE_SUPABASE_URL=https://mock.supabase.test VITE_SUPABASE_PUBLISHABLE_KEY=mock)
//   npx vite preview --outDir dist-mock --port 4174 &  node scripts/ui-smoke.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const axe = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: 'Hi there', avatar_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', bio: '', avatar_path: null, location: null, interests: ['Music'], dm_policy: 'friends', onboarded_at: now }
const post = (id, extra = {}) => ({ id, author: OTHER, body: 'Sunset run at the beach', media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: other, reactions: [{ count: 2 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [], ...extra })
const event = { id: 'e1', host: OTHER, title: 'Beach day', description: 'Bring snacks', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Clifton', visibility: 'public', capacity: 20, community_id: null, price_cents: 15000, currency: 'ZAR', ticket_url: 'https://tickets.example.com', status: 'active', organization_id: null, city: 'Cape Town', country: 'South Africa', venue: 'The Roof', address: '1 Long St', lat: -33.92, lng: 18.42, profiles: other, going: [{ count: 3 }], ticket_types: [{ price_cents: 15000, status: 'active' }], event_lineup: [{ name: 'DJ Nova', role: 'Headliner', sort: 1 }] }
const community = { id: 'c1', name: 'Runners', description: 'We run', rules: 'Be kind', cover_path: null, topics: ['Fitness'], visibility: 'public', created_by: OTHER }
const T = {
  profiles: [me, other], posts: [post('p1'), post('p2', { media_path: `${OTHER}/x.png`, media_type: 'image' })], events: [event], communities: [community],
  community_members: [{ community_id: 'c1', user_id: ME, role: 'member', status: 'active', profiles: me, communities: { name: 'Runners' } }],
  event_rsvps: [{ event_id: 'e1', user_id: OTHER, status: 'going', profiles: other, events: event }],
  friendships: [{ id: 'f1', requester: OTHER, addressee: ME, status: 'pending' }],
  notifications: [{ id: 'n1', type: 'comment', entity_type: 'post', entity_id: 'p1', read_at: null, created_at: now, actor: other }],
  conversation_members: [{ conversation_id: 'cv1', user_id: OTHER, last_read_at: now, conversations: { id: 'cv1', is_group: false, title: null }, profiles: other }],
  messages: [{ id: 'm1', conversation_id: 'cv1', sender: OTHER, body: 'hello there', created_at: now, deleted_at: null, client_id: null }],
  conversations: [{ id: 'cv1' }], comments: [], saves: [], blocks: [], reports: [], audit_log: [],
  ticket_types: [{ id: 't1', event_id: 'e1', name: 'General', description: 'Standing', kind: 'single', group_size: 1, price_cents: 15000, quantity_total: 50, max_per_order: 6, sales_start: null, sales_end: null, status: 'active', sort: 1 }, { id: 't2', event_id: 'e1', name: 'Table for 4', description: '', kind: 'group', group_size: 4, price_cents: 50000, quantity_total: 5, max_per_order: 2, sales_start: null, sales_end: null, status: 'active', sort: 2 }],
  event_lineup: [{ id: 'l1', event_id: 'e1', name: 'DJ Nova', role: 'Headliner', bio: 'Live set', image_path: null, sort: 1 }],
  tickets: [{ id: 'k1', code: 'ABCDEFGHIJKLMNOPQRST', status: 'valid', transfers: 0, event_id: 'e1', owner: ME, events: { id: 'e1', title: 'Beach day', starts_at: later, timezone: 'Africa/Johannesburg', venue: 'The Roof', city: 'Cape Town' }, ticket_types: { name: 'General' } }],
  orders: [{ id: 'o1', status: 'paid', total_cents: 16050, fee_cents: 1050, subtotal_cents: 15000, provider: 'payfast', event_id: 'e1', created_at: now, events: { id: 'e1', title: 'Beach day' } }],
  invoices: [{ number: 'VYB-2026-000001', kind: 'receipt', issued_at: now, legal_name: 'VYBE', vat_number: null, buyer_name: 'Alice', lines: [{ name: 'General', qty: 1, unit_price_cents: 15000, line_total_cents: 15000, tickets: 1 }], subtotal_cents: 15000, fee_cents: 1050, fee_vat_cents: 0, total_cents: 16050, orders: { id: 'o1', provider: 'payfast', provider_ref: '1089250', refunded_cents: 0, events: { title: 'Beach day', starts_at: later, venue: 'The Roof', city: 'Cape Town' } } }],
  refunds: [{ id: 'r1', status: 'requested', kind: 'buyer_request', ticket_amount_cents: 15000, fee_amount_cents: 0, reason: 'Cannot come', error: null, provider: null, created_at: now, order_id: 'o1', orders: { id: 'o1', event_id: 'e1', buyer: OTHER, total_cents: 16050, events: { title: 'Beach day', organization_id: 'o1' }, profiles: other } }],
  payouts: [{ id: 'po1', amount_cents: 75000, status: 'requested', organization_id: 'o1', user_id: null, created_at: now, bank_reference: null, organizations: { name: 'Beach Co' }, profiles: null }],
  payout_accounts: [{ id: 'pa1', holder: 'Beach Co', bank: 'FNB', account_last4: '5678', status: 'pending', organizations: { name: 'Beach Co' }, profiles: null }],
  promo_slides: [{ id: 'ps1', advertiser: 'Acme', title: 'Sundowners at Acme', subtitle: 'Two-for-one cocktails', cta_label: 'Book', cta_url: '/app/discover', media_type: null, media_path: null, poster_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'chime', city: null, priority: 50, status: 'live', starts_at: now, ends_at: null }], promo_stats: [{ slide_id: 'ps1', impressions: 10, clicks: 2 }],
  event_categories: [{ slug: 'concerts', label: 'Concerts & gigs', group_key: 'concerts', sort: 10, active: true }, { slug: 'community', label: 'Local community', group_key: 'events', sort: 140, active: true }], follows: [], event_saves: [],
  memories: [{ id: 'm1', kind: 'text', media_path: null, text_body: 'Golden hour', bg: 'rose', created_at: now, expires_at: later, visibility: 'friends', highlight: false, highlight_title: null }], memory_views: [], memory_reactions: [], memory_replies: [], post_media: [], post_tags: [], music_tracks: [], saved_tracks: [], profile_details: [], profile_private: [], verification_plans: [{ id: 'monthly', label: 'VYBE Verified · 1 month', days: 30, price_cents: 4900, active: true, sort: 10 }, { id: 'yearly', label: 'VYBE Verified · 1 year', days: 365, price_cents: 49900, active: true, sort: 20 }], badge_orders: [],
  disputes: [], ledger_entries: [{ id: 1, kind: 'sale', amount_cents: 15000, note: 'Ticket sales', created_at: now, event_id: 'e1', events: { title: 'Beach day' } }],
  live_streams: [{ id: 's1', host: OTHER, access: 'open', event_id: null, viewers_peak: 0, title: 'Sunset set', status: 'scheduled', visibility: 'public', scheduled_for: later, profiles: other }],
  organizations: [{ id: 'o1', name: 'Beach Co', slug: 'beach-co', kind: 'organizer', description: 'We host', verified_at: null }],
  organization_members: [{ user_id: ME, organization_id: 'o1', role: 'owner', status: 'active', profiles: me,  organization_id: 'o1', role: 'owner', status: 'active', organizations: { id: 'o1', name: 'Beach Co', slug: 'beach-co', kind: 'organizer', description: 'We host', verified_at: null } }],
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {}, created_at: now } }

const PUBLIC_ROUTES = ['/', '/signin', '/signup', '/forgot', '/privacy']
const ROUTES = ['/app', '/app/discover', '/app/discover?topic=Music', '/app/tickets', '/app/orders/o1', '/app/friends', '/app/plans', '/app/plans?new=1', '/app/communities?new=1', '/app/plans/e1', '/app/communities', '/app/communities/c1', '/app/messages', '/app/messages/cv1',
  '/app/notifications', '/app/search?q=ab', '/app/posts/p1', '/app/u/bob', '/app/u/alice', '/app/settings', '/app/settings/chat-security', '/app/live', '/app/live/s1', '/app/live/s1/host', '/app/earnings', '/app/orders/o1/receipt', '/app/onboarding', '/admin', '/admin/brand', '/org', '/org/beach-co', '/org/beach-co?tab=members', '/org/beach-co?tab=settings', '/org/beach-co?tab=finance', '/org/beach-co?tab=checkin', '/admin/finance', '/admin/promos', '/admin/discover', '/app/discover?mode=concerts', '/app/discover?mode=events', '/app/discover?mode=artists', '/app/discover?mode=communities', '/app/discover?mode=live', '/app/pages/beach-co', '/app/create', '/app/memories/new', `/app/memories/${OTHER}`, '/app/music', '/app/profile/edit', '/app/profile/settings', '/app/profile/settings/follow', '/app/profile/settings/highlights', '/app/profile/settings/archive', '/app/profile/settings/view-as', '/app/profile/settings/posts', '/app/profile/settings/tags', '/app/profile/settings/privacy', '/app/profile/settings/verified', '/app/people', '/app/messages', '/app/messages/cv1', '/app/u/alice?as=public', '/admin/music', '/admin/verification']

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
for (const [vp, signedIn] of [[{ width: 375, height: 760 }, true], [{ width: 1280, height: 800 }, true], [{ width: 375, height: 760 }, false], [{ width: 1280, height: 800 }, false]]) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: process.env.SCHEME || 'light' })
  // The entrance animation has its own check (scripts/splash-check.mjs); here it is marked as already played.
  await ctx.addInitScript(() => { try { sessionStorage.setItem('vybe:splash:v1', '1') } catch {} })
  if (signedIn) await ctx.addInitScript(s => localStorage.setItem('sb-mock-auth-token', s), JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const req = route.request(), u = new URL(req.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    if (u.pathname.startsWith('/storage/v1/object/sign')) return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify({ signedURL: '/object/sign/media/x.png?token=t' }) })
    if (u.pathname.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: h, contentType: 'image/png', body: PNG })
    if (u.pathname === '/rest/v1/rpc/is_staff' || u.pathname === '/rest/v1/rpc/is_admin') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: 'true' })
    const RPC = { org_overview: { role: 'owner', events_upcoming: 1, events_past: 2, events_draft: 0, going_upcoming: 12, members: 2, invited: 0, followers: 40, posts: 3, posts_30d: 1, next_event: null, campaigns: {}, impressions_30d: 0, clicks_30d: 0, tickets_30d: 4 },
      org_activity: [{ id: 1, at: now, action: 'org.updated', detail: { fields: ['website'] }, actor: { username: 'alice', display_name: 'Alice' } }],
      memory_rail: [{ author: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: new Date(Date.now() + 864e5 * 30).toISOString() }, count: 2, unseen: 1, latest_at: now, friend: true, cover: { kind: 'text', media_path: null, text_body: 'Golden hour', bg: 'rose' } }],
      author_memories: [{ id: 'm1', kind: 'text', media_path: null, text_body: 'Golden hour', bg: 'rose', created_at: now, expires_at: later, visibility: 'friends', highlight: false, highlight_title: null, mine_reaction: null, seen: false, views: 3, reactions: 1, replies: 1 }],
      music_catalog: [{ id: 'tr1', title: 'Zange', artist: 'Bongeziwe', artwork_path: null, preview_path: null, external_url: 'https://example.com/zange', saved: false }],
      get_profile_details: { level: 3, about: 'Hello there', personal: { current_city: 'Cape Town', hometown: 'Durban', relationship: 'single', gender: null, languages: ['English'], birthday: '17 May' }, work: [{ employer: 'Beach Co', role: 'Host' }], education: [{ school: 'UCT', field: 'Design' }], hobbies: ['Surfing'], travel: ['Zanzibar'], links: [{ label: 'Site', url: 'https://example.com' }], contact: { social: '@alice' } },
      profile_stats: { friends: 80, posts: 12, followers: 1200, following: 15, i_follow: false, follows_me: true },
      profile_followed_by: { count: 3, people: [{ username: 'bob', display_name: 'Bob', avatar_path: null }] },
      people_suggestions: [{ id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null, follows_me: true, friend: false, mutual: 2, shared: ['Music'] }],
      home_hero_settings: { trending_enabled: true, max_trending: 5, autoplay_ms: 7000, sponsored_every: 3 },
      discover_events: [{ id: 'e1', title: 'Beach day', starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', city: 'Cape Town', venue: 'Clifton', location: null, cover_path: null, category: 'concerts', category_label: 'Concerts & gigs', format: 'in_person', lat: -33.9, lng: 18.4, distance_km: 4.2, source: 'vybe', source_name: null, price_from_cents: 15000, price_cents: 15000, currency: 'ZAR', has_tickets: true, going: 12, friends_going: 1, friend_avatars: [{ username: 'bob', display_name: 'Bob', avatar_path: null }], followed: true, live: true, artists: ['DJ Nova'], host: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null }, org: { id: 'o1', name: 'Beach Co', slug: 'beach-co', verified: false } }],
      discover_orgs: [{ id: 'o1', name: 'Beach Co', slug: 'beach-co', kind: 'artist', description: 'We host', avatar_path: null, verified: false, followers: 3, upcoming: 1, following: false }],
      discover_live: [{ id: 's1', title: 'Sunset set live', status: 'live', access: 'open', scheduled_for: later, started_at: now, viewers: 5, can_watch: true, host: 'Bob', org: 'Beach Co', event: { id: 'e1', title: 'Beach day', city: 'Cape Town', venue: 'Clifton', cover_path: null, starts_at: later, timezone: 'Africa/Johannesburg', format: 'in_person' } }],
      event_social: { going: 12, interested: 3, saved: false, mine: null, people: [{ id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, status: 'going', friend: true }] },
      follow_stats: { followers: 3, following: false },
      trending_events: [{ id: 'e1', title: 'Beach day', starts_at: later, timezone: 'Africa/Johannesburg', city: 'Cape Town', venue: 'Clifton', cover_path: null, going: 12, price_from_cents: 15000, trending: true, score: 30 }],
      payout_balance: { gross_sales_cents: 120000, settled_sales_cents: 90000, refunds_and_chargebacks_cents: 15000, paid_out_cents: 0, pending_payout_cents: 0, open_disputes_cents: 0, balance_cents: 105000, available_cents: 75000, min_payout_cents: 10000, hold_days: 3 },
      admin_finance_summary: { paid_orders: 12, ticket_sales_cents: 120000, service_fees_cents: 9000, service_fee_vat_cents: 0, refunded_cents: 15000, by_provider: { payfast: 100000, ozow: 29000 }, open_refunds: 1, open_disputes: 0, payouts_awaiting: 1, accounts_to_verify: 1 },
      admin_get_config: { fee_bps: 500, fee_fixed_cents: 300, hold_minutes: 15, max_tickets_per_order: 20, vat_registered: false, vat_rate_bps: 1500, vat_number: null, legal_name: 'VYBE', settlement_hold_days: 3, payout_min_cents: 10000, buyer_refund_hours: 48 } }
    const rpcName = u.pathname.replace('/rest/v1/rpc/', '')
    if (u.pathname.startsWith('/rest/v1/rpc/') && rpcName in RPC) return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(RPC[rpcName]) })
    if (u.pathname === '/rest/v1/rpc/events_near') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify([event]) })
    if (u.pathname === '/rest/v1/rpc/ticket_units_taken') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: '3' })
    if (u.pathname === '/rest/v1/rpc/can_manage_event') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: 'false' })
    if (u.pathname === '/rest/v1/rpc/get_auth_hero') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: process.env.HERO_JSON ?? 'null' })
    const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/)
    if (m && req.method() === 'GET') {
      let rows = T[m[1]] ?? []
      for (const [k, v] of u.searchParams) if (v.startsWith('eq.') && rows.length && k in rows[0] && typeof rows[0][k] !== 'object') rows = rows.filter(r => String(r[k]) === v.slice(3))
      const obj = (req.headers().accept ?? '').includes('vnd.pgrst.object')
      if (req.headers()['prefer']?.includes('count') || req.method() === 'HEAD') h['content-range'] = `0-0/${rows.length}`
      return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(obj ? (rows[0] ?? null) : rows) })
    }
    return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: '[]' })
  })
  await ctx.route('**/*.png', r => r.request().url().includes('mock.supabase') ? r.fallback() : r.fallback())
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error' && !/WebSocket|realtime|ERR_FAILED|Failed to load resource/i.test(m.text())) errs.push(`console: ${m.text()}`) })
  for (const r of signedIn ? ROUTES : PUBLIC_ROUTES) {
    errs.length = 0
    await page.goto(BASE + r); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(350)
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${vp.width}${signedIn ? '' : 'out'}-${r.replace(/[^a-z0-9]+/gi, '_')}.png` })
    if (process.env.OVF) console.log(r, await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))))
    const landed = new URL(page.url()); const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    const h1 = await page.locator('h1').count()
    await page.evaluate(axe)
    const res = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }))
    const problems = [...errs, ...(overflow ? ['horizontal overflow'] : []), ...(h1 === 0 ? ['no <h1>'] : []), ...(signedIn && landed.pathname.startsWith('/signin') ? ['redirected to sign-in'] : []),
      ...res.violations.map(v => `axe ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].html.slice(0, 100)}`)]
    if (problems.length) { failures++; console.log(`✗ ${vp.width}${signedIn ? '' : ' signed-out'} ${r}`); problems.forEach(p => console.log('    ' + p)) } else console.log(`✓ ${vp.width}${signedIn ? '' : ' signed-out'} ${r}`)
  }
  await ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} route(s) with problems` : '\nall routes clean')
process.exit(failures ? 1 : 0)
