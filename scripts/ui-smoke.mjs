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
const event = { id: 'e1', host: OTHER, title: 'Beach day', description: 'Bring snacks', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Clifton', visibility: 'public', capacity: 20, community_id: null, price_cents: 15000, currency: 'ZAR', ticket_url: 'https://tickets.example.com', status: 'active', organization_id: null, profiles: other }
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
  live_streams: [{ id: 's1', host: OTHER, title: 'Sunset set', status: 'scheduled', visibility: 'public', scheduled_for: later, profiles: other }],
  organization_members: [{ organization_id: 'o1', role: 'owner', status: 'active', organizations: { id: 'o1', name: 'Beach Co', slug: 'beach-co', kind: 'organizer', description: 'We host', verified_at: null } }],
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {}, created_at: now } }

const PUBLIC_ROUTES = ['/', '/signin', '/signup', '/forgot', '/privacy']
const ROUTES = ['/app', '/app/discover', '/app/friends', '/app/plans', '/app/plans?new=1', '/app/plans/e1', '/app/communities', '/app/communities/c1', '/app/messages', '/app/messages/cv1',
  '/app/notifications', '/app/search?q=ab', '/app/posts/p1', '/app/u/bob', '/app/u/alice', '/app/settings', '/app/live', '/app/organizations', '/app/admin', '/app/onboarding']

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
for (const [vp, signedIn] of [[{ width: 375, height: 760 }, true], [{ width: 1280, height: 800 }, true], [{ width: 375, height: 760 }, false], [{ width: 1280, height: 800 }, false]]) {
  const ctx = await browser.newContext({ viewport: vp })
  // The entrance animation has its own check (scripts/splash-check.mjs); here it is marked as already played.
  await ctx.addInitScript(() => { try { sessionStorage.setItem('vybe:splash:v1', '1') } catch {} })
  if (signedIn) await ctx.addInitScript(s => localStorage.setItem('sb-mock-auth-token', s), JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const req = route.request(), u = new URL(req.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    if (u.pathname.startsWith('/storage/v1/object/sign')) return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify({ signedURL: '/object/sign/media/x.png?token=t' }) })
    if (u.pathname.startsWith('/storage/v1/')) return route.fulfill({ status: 200, headers: h, contentType: 'image/png', body: PNG })
    if (u.pathname === '/rest/v1/rpc/is_staff' || u.pathname === '/rest/v1/rpc/is_admin') return route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: 'true' })
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
