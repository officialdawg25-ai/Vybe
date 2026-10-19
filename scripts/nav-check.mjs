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
    if (t === 'posts') {
      const q = u.search
      return json(q.includes('visibility=eq.public') ? [post('p9', 'zzzzzzzz-0000-4000-8000-00000000000a', 'A stranger public post')] : [post('p1', FRIEND, 'Friend post'), post('p2', ME, 'My own post')])
    }
    return json([])
  })
  const page = await ctx.newPage()
  return { page, ctx, urls }
}
const cur = page => page.locator('.hdr-nav [aria-current="page"], .bottomnav [aria-current="page"]').first().getAttribute('aria-label').catch(() => null)

let t = await open(1280)
await t.page.goto(BASE + '/app'); await t.page.waitForTimeout(700)
check('Home: header tab "Home" is the selected destination', (await t.page.locator('.hdr-nav a[aria-current="page"]').getAttribute('aria-label')) === 'Home')
check('Home: shows friend and own posts, not strangers', await t.page.getByText('Friend post').isVisible() && await t.page.getByText('My own post').isVisible() && await t.page.getByText('A stranger public post').count() === 0)
const homeQuery = t.urls.find(u => u.startsWith('/rest/v1/posts'))
check('Home: query selects friends + self + joined communities', homeQuery.includes(`author.in.(${ME},${FRIEND})`) && homeQuery.includes(`community_id.in.(${COMM})`) && !homeQuery.includes('visibility=eq.public'), homeQuery.slice(0, 160))
await t.page.goto(BASE + '/app/discover'); await t.page.waitForTimeout(700)
check('Discover: header tab "Discover" is the selected destination', (await t.page.locator('.hdr-nav a[aria-current="page"]').getAttribute('aria-label')) === 'Discover')
check('Discover: shows public posts from outside the circle only', await t.page.getByText('A stranger public post').isVisible() && await t.page.getByText('Friend post').count() === 0)
const dq = t.urls.filter(u => u.startsWith('/rest/v1/posts')).pop()
check('Discover: query is public-only and excludes self and friends', dq.includes('visibility=eq.public') && dq.includes(`author=not.in.(${ME},${FRIEND})`), dq.slice(0, 200))
check('Home and Discover render different headings/sections', await t.page.getByRole('heading', { name: 'Latest public posts' }).isVisible() && await t.page.getByRole('heading', { name: 'Your plans' }).count() === 0)

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
