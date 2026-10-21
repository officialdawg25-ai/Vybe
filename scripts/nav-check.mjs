// Navigation checks against a MOCKED backend: selected states, the account menu's overlay behaviour, and proof
// that Home and Discover issue different queries. Rendering/behaviour only; RLS is covered by tests/db.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', FRIEND = 'bbbbbbbb-0000-4000-8000-000000000002', COMM = 'cccccccc-0000-4000-8000-000000000003'
const now = new Date().toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'a@e.com', app_metadata: {}, user_metadata: {}, created_at: now } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: null, interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now }
const friend = { id: FRIEND, username: 'bob', display_name: 'Bob', avatar_path: null }
const post = (id, author, body, extra = {}) => ({ id, author, body, media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: author === ME ? me : friend, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], ...extra })

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } })
  await ctx.addInitScript(s => { localStorage.setItem('sb-mock-auth-token', s); sessionStorage.setItem('vybe:splash:v1', '1') }, JSON.stringify(session))
  const urls = []
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    const json = b => route.fulfill({ status: 200, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    urls.push(decodeURIComponent(u.pathname + u.search))
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const t = u.pathname.replace('/rest/v1/', '')
    if (t === 'rpc/is_staff') return json(true)
    if (t === 'rpc/is_admin') return json(false)
    if (t === 'profiles') return json(obj ? me : [me])
    if (t === 'friendships') return json([{ id: 'f1', requester: ME, addressee: FRIEND, status: 'accepted' }])
    if (t === 'community_members') return json([{ community_id: COMM, user_id: ME, role: 'member', status: 'active' }])
    if (t === 'posts') return json([post('p1', FRIEND, 'Friend post'), post('p2', ME, 'My own post')])
    if (t === 'rpc/events_near') return json([{ id: 'e1', host: FRIEND, title: 'Beach day', description: '', cover_path: null, starts_at: new Date(Date.now() + 864e5).toISOString(), ends_at: null, timezone: 'Africa/Johannesburg', location: null, visibility: 'public', capacity: null, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', city: 'Durban', venue: 'Pier', lat: -29.86, lng: 31.02, profiles: friend }])
    return json([])
  })
  const page = await ctx.newPage()
  return { page, ctx, urls }
}
const cur = page => page.locator('.hdr-nav [aria-current="page"], .bottomnav [aria-current="page"]').first().getAttribute('aria-label').catch(() => null)

let t = await open(1280)
await t.page.goto(BASE + '/app'); await t.page.waitForTimeout(700)
check('Home: header tab "Home" is the selected destination', (await t.page.locator('.hdr-nav a[aria-current="page"]').getAttribute('aria-label')) === 'Home')
check('Home: shows friend posts and own posts', await t.page.getByText('Friend post').isVisible() && await t.page.getByText('My own post').isVisible())
const homeQuery = t.urls.filter(u => u.startsWith('/rest/v1/posts')).pop()
check('Home "For you": reads every post RLS allows (no author or visibility filter)', !homeQuery.includes('author=in') && !homeQuery.includes('visibility=eq.public'), homeQuery.slice(0, 120))
await t.page.getByRole('tab', { name: 'Friends' }).click(); await t.page.waitForTimeout(500)
const fq = t.urls.filter(u => u.startsWith('/rest/v1/posts')).pop()
check('Home "Friends" tab filters to friends + self', fq.includes(`author=in.(${ME},${FRIEND})`), fq.slice(0, 200))
await t.page.getByRole('tab', { name: 'Pages' }).click(); await t.page.waitForTimeout(400)
check('Home "Pages" tab asks for organization posts only', t.urls.filter(u => u.startsWith('/rest/v1/posts')).pop().includes('organization_id=not.is.null'))
await t.page.getByRole('tab', { name: 'Plans' }).click(); await t.page.waitForTimeout(400)
check('Home "Plans" tab asks for posts that share a plan', t.urls.filter(u => u.startsWith('/rest/v1/posts')).pop().includes('event_id=not.is.null'))
check('Home has a minimal composer pill and quick tiles', await t.page.getByRole('button', { name: /What’s on your mind/ }).isVisible() && await t.page.getByRole('link', { name: 'Share a memory' }).isVisible() && await t.page.getByRole('link', { name: /Discover music/ }).isVisible())
await t.page.getByRole('button', { name: /What’s on your mind/ }).click()
await t.page.waitForTimeout(600)
check('composer pill opens the full-screen create-post screen', new URL(t.page.url()).pathname === '/app/create' && await t.page.getByRole('dialog', { name: 'New post' }).getByRole('textbox').isVisible())
await t.page.goBack(); await t.page.waitForTimeout(300)
await t.page.goto(BASE + '/app/discover'); await t.page.waitForTimeout(800)
check('Discover: header tab "Discover" is the selected destination', (await t.page.locator('.hdr-nav a[aria-current="page"]').getAttribute('aria-label')) === 'Discover')
const near = t.urls.find(u => u.includes('rpc/discover_events'))
check('Discover: asks the database for events (server-side filters, place and radius)', Boolean(near), near)
check('Discover: shows the place and lets you change it', await t.page.locator('.shz-loc .chip').nth(1).isVisible())
await t.page.locator('.shz-loc .chip').nth(1).click()
await t.page.getByRole('dialog').getByRole('searchbox').fill('Dur')
check('Discover: location picker searches cities', await t.page.getByRole('dialog').getByText('Durban').isVisible())
await t.page.getByRole('dialog').getByText('Durban').click(); await t.page.waitForTimeout(600)
check('Discover: switching place re-queries events for the new coordinates', t.urls.filter(u => u.includes('rpc/discover_events')).length > 3)
check('Discover has no social feed (that lives on Home)', await t.page.getByRole('heading', { name: 'Latest public posts' }).count() === 0)

// account menu overlay behaviour
await t.page.goto(BASE + '/app'); await t.page.waitForTimeout(500)
const trigger = t.page.getByRole('button', { name: 'Account menu' })
await trigger.click()
check('account menu opens with menu items', await t.page.getByRole('menuitem', { name: 'Sign out' }).isVisible() && (await trigger.getAttribute('aria-expanded')) === 'true')
check('first item receives focus', await t.page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'))
await t.page.keyboard.press('ArrowDown'); await t.page.keyboard.press('ArrowUp')
await t.page.keyboard.press('Escape')
check('Escape closes the menu and returns focus to its trigger', await t.page.getByRole('menu').count() === 0 && await t.page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Account menu'))
await trigger.click(); await t.page.mouse.click(600, 400)
check('clicking outside closes the menu', await t.page.getByRole('menu').count() === 0)
await trigger.click(); await t.page.getByRole('menuitem', { name: 'Settings' }).click(); await t.page.waitForTimeout(300)
check('choosing an item navigates and closes the menu', t.page.url().endsWith('/app/settings') && await t.page.getByRole('menu').count() === 0)
check('Admin portal link is offered to staff', await (async () => { await trigger.click(); const v = await t.page.getByRole('menuitem', { name: 'Admin portal' }).isVisible(); await t.page.keyboard.press('Escape'); return v })())
await t.ctx.close()

t = await open(375)
await t.page.goto(BASE + '/app/discover'); await t.page.waitForTimeout(600)
check('mobile: bottom bar has 5 primary destinations, Discover selected', await t.page.locator('.bottomnav a').count() === 5 && (await t.page.locator('.bottomnav a[aria-current="page"]').innerText()).trim() === 'Discover')
await t.page.getByRole('button', { name: 'Account menu' }).click()
const box = await t.page.getByRole('menu').boundingBox()
check('mobile: account menu stays inside the viewport', box.x >= 0 && box.x + box.width <= 375 && box.y + box.height <= 800, JSON.stringify(box))
check('mobile: no horizontal overflow', !(await t.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)))
await t.ctx.close()

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall navigation checks passed')
process.exit(failures ? 1 : 0)
