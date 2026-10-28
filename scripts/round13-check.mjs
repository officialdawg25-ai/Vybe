// Browser checks for sponsored posts (boost) against a MOCKED backend: the label and call-to-action in the feed, counting,
// the ad menu, hiding, the boost wizard through to the payment hand-off, the dashboard and the admin screen (+ axe).
// Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174).
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const axe = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 5 * 864e5).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, location: 'Cape Town, South Africa', interests: ['Music'], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null, verified_until: null }
const mkPost = (id, author, body, extra = {}) => ({ id, author, body, media_path: null, media_type: null, visibility: 'public', community_id: null, event_id: null, created_at: new Date(Date.now() - Number(id.replace(/\D/g, '') || 0) * 60000).toISOString(), edited_at: null, profiles: author === ME ? me : other, reactions: [{ count: 0 }], comments: [{ count: 0 }], mine_reaction: [], mine_save: [], ...extra })
const feedPosts = [mkPost('p1', ME, 'My own public post'), ...[2, 3, 4, 5, 6, 7, 8].map(n => mkPost(`p${n}`, OTHER, `Regular post ${n}`))]
const adPost = mkPost('ad1', OTHER, 'Summer Sessions — tickets on sale now', { music_title: 'A very long song title that does not fit on one line', music_artist: 'Some Artist' })
const ad = { id: 'sp1', post_id: 'ad1', goal: 'link', cta_label: 'Get tickets', cta_url: 'https://tickets.example.com/summer', sponsor: OTHER, audience_city: 'Cape Town', audience_interests: ['Music'] }
const pkgs = [{ id: 'boost_3', label: 'Boost · 3 days', days: 3, price_cents: 9900, sort: 10 }, { id: 'boost_7', label: 'Boost · 7 days', days: 7, price_cents: 19900, sort: 20 }, { id: 'boost_14', label: 'Boost · 14 days', days: 14, price_cents: 34900, sort: 30 }]
const sponsorships = [
  { id: 's1', post_id: 'p1', package_id: 'boost_7', days: 7, total_cents: 19900, goal: 'engage', cta_label: null, cta_url: null, audience_city: null, audience_interests: [], status: 'live', review_note: null, starts_at: now, ends_at: later, paid_at: now, refund_due_cents: 0, refunded_at: null, created_at: now, posts: { body: 'My own public post', media_type: null } },
  { id: 's2', post_id: 'p2', package_id: 'boost_3', days: 3, total_cents: 9900, goal: 'link', cta_label: 'Learn more', cta_url: 'https://x.example.com/page', audience_city: 'Durban', audience_interests: ['Food'], status: 'rejected', review_note: 'Misleading claim', starts_at: null, ends_at: null, paid_at: now, refund_due_cents: 9900, refunded_at: null, created_at: now, posts: { body: 'Another', media_type: null } },
]
const queue = [{ id: 's9', status: 'in_review', post_id: 'ad1', body: 'Summer Sessions — tickets on sale now', media_path: null, media_type: null, sponsor_name: 'Bob', sponsor_username: 'bob', goal: 'link', cta_url: 'https://tickets.example.com/summer', cta_label: 'Get tickets', audience_city: 'Cape Town', audience_interests: ['Music'], days: 7, total_cents: 19900, paid_at: now, refund_due_cents: 0, refunded_at: null, review_note: null },
  { id: 's8', status: 'rejected', post_id: 'p3', body: 'x', media_path: null, media_type: null, sponsor_name: 'Carol', sponsor_username: 'carol', goal: 'engage', cta_url: null, cta_label: null, audience_city: null, audience_interests: [], days: 3, total_cents: 9900, paid_at: now, refund_due_cents: 9900, refunded_at: null, review_note: 'Not allowed' }]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function open(url, { admin = false, hidden = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const seen = { rpc: [], fn: [], form: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    let body = null; try { body = JSON.parse(r.postData() ?? 'null') } catch {}
    const p = u.pathname
    if (p.startsWith('/storage/v1/object/sign/media')) return json({ signedURL: '/object/sign/media/x?token=t' })
    if (p.startsWith('/storage/v1/object/public/brand/')) return route.fulfill({ status: 404, headers: h, body: '' })
    if (p.startsWith('/functions/v1/')) { seen.fn.push({ name: p.split('/').pop(), body }); return json({ action: 'https://sandbox.payfast.test/eng/process', method: 'POST', fields: { merchant_id: '1', amount: '199.00', item_name: 'VYBE sponsored post' } }) }
    if (p.startsWith('/rest/v1/rpc/')) {
      const name = p.split('/').pop(); seen.rpc.push({ name, body })
      if (name === 'my_profile') return json(me)
      if (name === 'is_staff' || name === 'is_admin') return json(admin)
      if (name === 'sponsored_feed') return json(hidden ? [] : [ad])
      if (name === 'sponsored_why') return json({ city: 'Cape Town', interests: ['Music'], sponsor_name: 'Bob' })
      if (name === 'track_sponsored') return json(true)
      if (name === 'create_sponsor_order') return json({ id: 'ord1', sponsorship_id: 's9', status: 'pending', total_cents: 19900, expires_at: later })
      if (name === 'admin_sponsorship_queue') return json(queue)
      if (name === 'admin_review_sponsorship' || name === 'admin_mark_sponsor_refunded' || name === 'hide_sponsored' || name === 'pause_sponsorship' || name === 'stop_sponsorship') return route.fulfill({ status: 204, headers: h, body: '' })
      return json(name.includes('hero') ? {} : obj ? null : [])
    }
    if (p === '/rest/v1/posts') {
      const id = u.searchParams.get('id') ?? ''
      if (id.startsWith('in.')) return json(id.includes('ad1') ? [adPost] : id.includes('p1') ? [feedPosts[0]] : [])
      if (u.searchParams.get('author')?.startsWith('eq.')) return json([{ id: 'p1', body: 'My own public post', media_type: null, created_at: now }])
      return json(feedPosts)
    }
    if (p === '/rest/v1/boost_packages') return json(pkgs)
    if (p === '/rest/v1/sponsored_posts') return json(sponsorships)
    if (p === '/rest/v1/sponsor_stats') return json([{ sponsored_id: 's1', impressions: 420, clicks: 21, reach: 180 }])
    if (p === '/rest/v1/sponsor_orders') return json(obj ? { status: 'pending' } : [])
    if (p === '/rest/v1/profiles') { const id = u.searchParams.get('id')?.replace('eq.', ''); const one = id === OTHER ? other : me; return json(obj ? one : id ? [one] : [me, other]) }
    return json(obj ? null : [])
  })
  await ctx.route('https://tickets.example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>tickets</h1>' }))
  await ctx.route('https://sandbox.payfast.test/**', route => { seen.form.push({ url: route.request().url(), body: route.request().postData() }); return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>payfast</h1>' }) })
  const page = await ctx.newPage()
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}
const scan = async page => { await page.evaluate(axe); const r = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] })); return r.violations.map(v => `${v.id} (${v.impact}) ${v.nodes[0].html.slice(0, 90)}`) }

// 1. In the feed.
{
  const t = await open('/app')
  await t.page.waitForSelector('.igp'); await t.page.waitForTimeout(800)
  const labels = await t.page.locator('.igp-spons').allInnerTexts()
  check('exactly one post carries the "Sponsored" label', labels.length === 1 && labels[0] === 'Sponsored', JSON.stringify(labels))
  const idx = await t.page.locator('article.igp').evaluateAll(els => els.findIndex(e => e.querySelector('.igp-spons')))
  check('it sits after the 6th regular post', idx === 6, `index ${idx}`)
  const art = t.page.locator('article.igp', { has: t.page.locator('.igp-spons') })
  await art.scrollIntoViewIfNeeded(); await t.page.waitForTimeout(1500)
  check('an impression is counted after a second on screen', t.seen.rpc.some(r => r.name === 'track_sponsored' && r.body.p_id === 'sp1' && r.body.p_kind === 'impression'))
  check('the button shows the sponsor’s text and a safe external link', await art.locator('a.igp-cta', { hasText: 'Get tickets' }).getAttribute('rel').then(v => /noopener/.test(v) && /sponsored/.test(v) && /nofollow/.test(v)))
  check('long song name scrolls instead of being cut off', await art.locator('.mq.run').count() === 1, 'marquee on the sponsored line')
  const popup = t.ctx.waitForEvent('page'); await art.locator('a.igp-cta').click(); const pp = await popup.catch(() => null)
  await t.page.waitForTimeout(300)
  check('tapping the button counts a click and opens the link', t.seen.rpc.some(r => r.name === 'track_sponsored' && r.body.p_kind === 'click') && Boolean(pp))
  await pp?.close()
  // menu
  await art.getByRole('button', { name: 'More options' }).click()
  const opts = await t.page.locator('.sheet .btn').allInnerTexts()
  check('ad menu: why, hide, report — and no Boost', opts.some(o => /Why am I seeing this ad/.test(o)) && opts.some(o => /Hide this ad/.test(o)) && opts.some(o => /Report ad/.test(o)) && !opts.some(o => /Boost post/.test(o)), opts.join(' | '))
  await t.page.getByRole('button', { name: /Why am I seeing this ad/ }).click()
  await t.page.getByText(/paid promotion/).waitFor({ timeout: 8000 }).catch(() => {})
  const why = await t.page.locator('.sheet').innerText()
  check('"Why am I seeing this" names the sponsor and the audience chosen', /Bob/.test(why) && /Cape Town/.test(why) && /Music/.test(why))
  check('the sheet has no accessibility violations', (await scan(t.page)).length === 0)
  await t.page.keyboard.press('Escape')
  await art.getByRole('button', { name: 'More options' }).click(); await t.page.getByRole('button', { name: 'Hide this ad' }).click(); await t.page.waitForTimeout(400)
  check('hiding removes it and tells the database', await t.page.locator('.igp-spons').count() === 0 && t.seen.rpc.some(r => r.name === 'hide_sponsored' && r.body.p_id === 'sp1'))
  // own post offers Boost
  await t.page.locator('article.igp').first().getByRole('button', { name: 'More options' }).click()
  check('your own public post offers "Boost post"', await t.page.locator('.sheet a', { hasText: 'Boost post' }).getAttribute('href') === '/app/boost/p1')
  check('no page errors in the feed', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. No ad when delivery returns none (hidden, capped, wrong audience…).
{
  const t = await open('/app', { hidden: true })
  await t.page.waitForSelector('.igp'); await t.page.waitForTimeout(500)
  check('no label appears when the database serves no ad', await t.page.locator('.igp-spons').count() === 0)
  await t.ctx.close()
}

// 3. The boost wizard.
{
  const t = await open('/app/boost/p1')
  await t.page.waitForSelector('.bp-preview'); await t.page.waitForTimeout(500)
  check('the preview shows the Sponsored label', await t.page.locator('.bp-preview .igp-spons').count() === 1)
  check('the preview cannot be tapped (inert)', await t.page.locator('.bp-preview').evaluate(e => e.hasAttribute('inert')))
  const pay = t.page.locator('button.btn.primary', { hasText: /Pay R|Opening payment/ })
  check('Pay is disabled until the ad rules are confirmed', await pay.isDisabled())
  await t.page.getByLabel('Website visit').or(t.page.getByText('Visit a website')).first().click()
  check('a link goal needs a secure link', await pay.isDisabled() === true)
  await t.page.getByLabel('Website link').fill('http://insecure.example.com'); await t.page.getByLabel(/I confirm this post follows/).check()
  check('an insecure link keeps Pay disabled', await pay.isDisabled())
  await t.page.getByLabel('Website link').fill('https://tickets.example.com/summer'); await t.page.getByLabel('Button text').fill('Get tickets')
  await t.page.getByRole('button', { name: 'People in a city' }).click(); await t.page.getByRole('button', { name: 'Music' }).click()
  await t.page.getByText('14 days').click()
  check('the price shown is the server’s package price', /R\s?349/.test(await pay.innerText()), await pay.innerText())
  check('the wizard has no accessibility violations', (await scan(t.page)).length === 0, (await scan(t.page)).join(' ; '))
  await pay.click(); await t.page.waitForTimeout(900)
  const call = t.seen.rpc.find(r => r.name === 'create_sponsor_order')?.body
  check('the order is created with only ids and choices (never a price)', call && call.p_post === 'p1' && call.p_package === 'boost_14' && call.p_goal === 'link' && call.p_cta_url === 'https://tickets.example.com/summer' && call.p_city === 'Cape Town' && call.p_interests[0] === 'Music' && !('p_price' in call) && !('p_total' in call), JSON.stringify(call))
  check('then payment is started for that order and the form is posted to the provider', t.seen.fn.some(f => f.name === 'pay-start' && f.body.order_id === 'ord1') && t.seen.form.some(f => f.url.startsWith('https://sandbox.payfast.test/')))
  check('no page errors in the wizard', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 4. Dashboard and admin.
{
  const t = await open('/app/boost')
  await t.page.waitForSelector('.bo-card'); await t.page.waitForTimeout(400)
  const text = await t.page.locator('.bo-list').innerText()
  check('dashboard shows status, real insights and the refund owed for a rejected boost', /Running/.test(text) && /420/.test(text) && /180/.test(text) && /21/.test(text) && /5%/.test(text) && /Not approved: Misleading claim/.test(text) && /R\s?99,00|R\s?99\.00|R99/.test(text.replace(/\s/g, ' ')), text.slice(0, 300))
  check('live boost offers Pause and Stop', await t.page.getByRole('button', { name: 'Pause' }).count() === 1 && await t.page.getByRole('button', { name: 'Stop' }).count() === 1)
  await t.page.getByRole('button', { name: 'Pause' }).click(); await t.page.waitForTimeout(300)
  check('Pause calls the database', t.seen.rpc.some(r => r.name === 'pause_sponsorship' && r.body.p_id === 's1' && r.body.p_pause === true))
  check('dashboard has no accessibility violations', (await scan(t.page)).length === 0, (await scan(t.page)).join(' ; '))
  await t.ctx.close()
}
{
  const t = await open('/admin/sponsorship', { admin: true })
  await t.page.waitForSelector('#sp-q'); await t.page.waitForTimeout(500)
  check('admin sees the review queue with the destination link to check', /Waiting for review \(1\)/.test(await t.page.locator('#sp-q').innerText()) && await t.page.locator('a[href="https://tickets.example.com/summer"]').count() === 1)
  await t.page.getByRole('button', { name: 'Approve', exact: true }).click(); await t.page.waitForTimeout(300)
  check('Approve calls the review function', t.seen.rpc.some(r => r.name === 'admin_review_sponsorship' && r.body.p_id === 's9' && r.body.p_approve === true))
  await t.page.getByRole('button', { name: /Don’t approve/ }).click()
  check('rejecting needs a reason (nothing is sent without one)', t.seen.rpc.filter(r => r.name === 'admin_review_sponsorship').length === 1)
  await t.page.getByLabel('Provider refund reference').fill('PF-REFUND-9'); await t.page.getByRole('button', { name: 'Mark refunded' }).click(); await t.page.waitForTimeout(300)
  check('a refund is recorded with the provider reference', t.seen.rpc.some(r => r.name === 'admin_mark_sponsor_refunded' && r.body.p_ref === 'PF-REFUND-9'))
  check('admin screen has no accessibility violations', (await scan(t.page)).length === 0, (await scan(t.page)).join(' ; '))
  await t.ctx.close()
}
await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
