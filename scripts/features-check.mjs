// Feature checks against a MOCKED backend: theme switching, interface sounds, voice notes (60 s cap), photo cropper + upload shrink,
// onboarding phases, sign-in → splash, many tabs signed in at once, ticket checkout hand-off, image loading behaviour.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const BIG = process.env.BIG_IMAGE
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {}, created_at: now } }
const me = (extra = {}) => ({ id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, location: 'Cape Town', interests: ['Music'], dm_policy: 'friends', notif_prefs: {}, onboarded_at: now, onboarding_step: 0, ...extra })
const other = { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: `${OTHER}/a.webp` }
const post = { id: 'p1', author: OTHER, body: 'Sunset run', media_path: `${OTHER}/x.webp`, media_type: 'image', visibility: 'public', community_id: null, event_id: null, created_at: now, edited_at: null, profiles: other, reactions: [{ count: 2 }], comments: [{ count: 1 }], mine_reaction: [], mine_save: [] }
const event = { id: 'e1', host: OTHER, title: 'Beach day', description: '', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: null, visibility: 'public', capacity: null, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', city: 'Cape Town', venue: 'The Roof', address: '1 Long St', lat: -33.92, lng: 18.42, profiles: other }
const TT = [{ id: 't1', event_id: 'e1', name: 'General', description: '', kind: 'single', group_size: 1, price_cents: 15000, quantity_total: 50, max_per_order: 6, sales_start: null, sales_end: null, status: 'active', sort: 1 }]
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }

async function ctxWith({ signedIn = true, profile = me(), width = 1280, pay = 'ok', live = 'down', refundStatus = 'approved', recordCalls = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['microphone'] })
  await ctx.addInitScript(([s, signed]) => { try { sessionStorage.setItem('vybe:splash:v1', '1'); if (signed) localStorage.setItem('sb-mock-auth-token', s) } catch {} }, [JSON.stringify(session), signedIn])
  const state = { profile, calls: recordCalls, uploads: [], orders: [] }
  await ctx.route('https://mock.supabase.test/**', async route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' }
    const json = (b, s = 200) => route.fulfill({ status: s, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const p = u.pathname, obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    if (p === '/auth/v1/token') return json({ ...session })
    if (p.startsWith('/functions/v1/')) {
      const fn = p.split('/').pop(); state.calls.push(`fn ${fn} ${r.postData() ?? ''}`.slice(0, 200))
      if (fn === 'pay-start') return pay === 'ok' ? json({ action: 'https://pay.ozow.com', method: 'POST', fields: { SiteCode: 'X', Amount: '175.50', HashCheck: 'abc' } }) : json({ error: 'Ozow is not configured yet.' }, 503)
      if (fn === 'livekit-token') return live === 'ticket' ? json({ error: 'You need a ticket for this event to watch' }, 403) : json({ error: 'Live streaming is not configured yet.' }, 503)
      if (fn === 'refund-process') return json({ status: 'succeeded' })
      return json({ error: 'unknown function' }, 404)
    }
    if (p.startsWith('/storage/v1/')) {
      state.calls.push(`${r.method()} ${p}`)
      if (r.method() === 'POST' && p === '/storage/v1/object/sign/media') return json(((r.postDataJSON?.() ?? {}).paths ?? []).map(x => ({ error: null, path: x, signedURL: `/object/sign/media/${x}?token=t` })))
      if (r.method() === 'GET' && p.startsWith('/storage/v1/object/sign/')) return route.fulfill({ status: 200, headers: { ...h, 'content-type': 'image/png' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64') })
      if (p.startsWith('/storage/v1/object/sign/')) return json({ signedURL: '/object/sign/media/x.webp?token=t' })
      if (r.method() === 'POST') { state.uploads.push({ path: p, type: r.headers()['content-type'], size: r.postDataBuffer()?.length ?? 0 }); return json({ Key: 'ok' }) }
      return route.fulfill({ status: 200, headers: h, contentType: 'image/png', body: PNG })
    }
    if (p.startsWith('/rest/v1/rpc/')) {
      const name = p.split('/').pop(); state.calls.push(`rpc ${name}`)
      if (name === 'is_staff' || name === 'is_admin' || name === 'can_manage_event') return json(false)
      if (name === 'ticket_units_taken') return json(3)
      if (name === 'get_auth_hero') return json(null)
      if (name === 'create_order') { state.orders.push(r.postDataJSON()); return json({ id: 'o-new', status: 'pending', total_cents: 17550, fee_cents: 1050, subtotal_cents: 16500, expires_at: later }) }
      if (name === 'events_near') return json([event])
      if (name === 'request_refund') return json({ id: 'rf-1', status: refundStatus, ticket_amount_cents: 15000, full: true })
      return json(null)
    }
    const t = p.replace('/rest/v1/', '')
    if (r.method() !== 'GET' && r.method() !== 'HEAD') { state.calls.push(`${r.method()} ${t} ${r.postData() ?? ''}`.slice(0, 220)); return json(r.method() === 'POST' && (r.headers().prefer ?? '').includes('return=representation') ? [{ id: 'new', ...(r.postDataJSON?.() ?? {}) }] : []) }
    const rows = { profiles: [state.profile], posts: [post], events: [event], ticket_types: TT, comments: [], friendships: [], community_members: [], communities: [], notifications: [], event_lineup: [], event_rsvps: [], orders: [{ id: 'o1', status: 'paid', total_cents: 16050, fee_cents: 1050, subtotal_cents: 15000, provider: 'payfast', event_id: 'e1', created_at: now, events: { id: 'e1', title: 'Beach day' } }], refunds: [], live_streams: [{ id: 's1', host: OTHER, title: 'Their set', status: 'live', visibility: 'public', access: 'ticket', event_id: 'e1', scheduled_for: null, viewers_peak: 3, profiles: { id: OTHER, username: 'bob', display_name: 'Bob', avatar_path: null } }, { id: 's2', host: ME, title: 'My set', status: 'scheduled', visibility: 'public', access: 'open', event_id: null, scheduled_for: later, viewers_peak: 0, profiles: { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null } }] }[t] ?? []
    const idq = u.searchParams.get('id'); const filtered = idq?.startsWith('eq.') ? rows.filter(x => x.id === idq.slice(3)) : rows
    return json(obj ? (filtered[0] ?? null) : filtered)
  })
  await ctx.route('https://pay.ozow.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: `<h1>ozow ${route.request().method()}</h1>` }))
  return { ctx, state }
}

// ---------------------------------------------------------------- theme
{
  const { ctx } = await ctxWith(); const page = await ctx.newPage()
  await page.goto(BASE + '/app/settings'); await page.waitForTimeout(500)
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  check('theme: choosing Dark sets data-theme and the dark background', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 13, 18)')
  await page.reload(); await page.waitForTimeout(300)
  check('theme: preference survives a reload (applied before first paint)', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  check('theme: Light switches back', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(250, 250, 251)')
  const page2 = await ctx.newPage(); await page2.goto(BASE + '/app'); await page2.waitForTimeout(300)
  await page.getByRole('radio', { name: 'Dark', exact: true }).click(); await page2.waitForTimeout(400)
  check('theme: a second open tab follows the change', (await page2.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await page2.getByRole('button', { name: 'Account menu' }).click()
  check('theme: account menu offers a theme switch', await page2.getByRole('menuitem', { name: /Theme:/ }).isVisible())
  await ctx.close()
}

// ---------------------------------------------------------------- sounds
{
  const { ctx } = await ctxWith(); const page = await ctx.newPage()
  await page.addInitScript(() => { window.__osc = 0; const o = AudioContext.prototype.createOscillator; AudioContext.prototype.createOscillator = function () { window.__osc++; return o.call(this) } })
  await page.goto(BASE + '/app'); await page.waitForTimeout(600)
  await page.mouse.click(5, 5)
  await page.getByRole('button', { name: 'Like' }).first().click(); await page.waitForTimeout(300)
  check('sounds: liking a post plays a chime (oscillators created)', (await page.evaluate(() => window.__osc)) >= 2)
  await page.goto(BASE + '/app/settings'); await page.waitForTimeout(400)
  await page.getByRole('checkbox', { name: /Interface sounds/ }).uncheck()
  await page.goto(BASE + '/app'); await page.waitForTimeout(500); await page.evaluate(() => { window.__osc = 0 })
  await page.getByRole('button', { name: 'Like' }).first().click(); await page.waitForTimeout(300)
  check('sounds: switching them off in Settings silences everything', (await page.evaluate(() => window.__osc)) === 0)
  await ctx.close()
}

// ---------------------------------------------------------------- voice notes
{
  const { ctx, state } = await ctxWith(); const page = await ctx.newPage()
  await page.goto(BASE + '/app/posts/p1'); await page.waitForTimeout(700)
  const rec = page.getByRole('button', { name: /Record a voice note/ })
  check('voice: record button is offered in the comment box', await rec.isVisible())
  await rec.click(); await page.waitForTimeout(1500)
  check('voice: recording shows a live timer with Done and Pause', await page.getByRole('group', { name: 'Recording voice note' }).isVisible() && await page.getByRole('button', { name: 'Done' }).isVisible() && await page.getByRole('button', { name: 'Pause recording' }).isVisible())
  await page.getByRole('button', { name: 'Done' }).click(); await page.waitForTimeout(500)
  check('voice: after stopping you can review, discard or send', await page.getByRole('group', { name: 'Review voice note' }).isVisible())
  await page.getByRole('button', { name: 'Send' }).click(); await page.waitForTimeout(700)
  check('voice: sending uploads audio under your folder and inserts the comment with its length', state.uploads.some(u => new RegExp(`/object/media/${ME}/[0-9a-f-]+\\.(webm|m4a|ogg)$`).test(u.path)) && state.calls.some(c => c.startsWith('POST comments') && c.includes('audio_path') && c.includes('audio_ms')), JSON.stringify(state.uploads.map(u => u.path)))
  // No time limit: still recording well past a minute (fake clock)
  const p2 = await ctx.newPage(); await p2.clock.install(); await p2.goto(BASE + '/app/posts/p1'); await p2.waitForTimeout(800)
  await p2.getByRole('button', { name: /Record a voice note/ }).click(); await p2.waitForTimeout(600)
  await p2.clock.fastForward(30_000)
  check('voice: at 30 s it is still recording', await p2.getByRole('group', { name: 'Recording voice note' }).isVisible())
  await p2.clock.fastForward(95_000); await p2.waitForTimeout(800)
  check('voice: there is no 60-second limit: still recording after 2 minutes', await p2.getByRole('group', { name: 'Recording voice note' }).isVisible())
  check('voice: the clock keeps counting past 1:00', /^(1:[5-9]\d|2:\d\d)/.test((await p2.locator('.voice-time').innerText()).trim()), await p2.locator('.voice-time').innerText())
  await ctx.close()
}

// ---------------------------------------------------------------- avatar cropper
{
  const { ctx, state } = await ctxWith(); const page = await ctx.newPage()
  await page.goto(BASE + '/app/settings'); await page.waitForTimeout(600)
  await page.setInputFiles('input[type=file][hidden]', BIG ?? { name: 'a.png', mimeType: 'image/png', buffer: PNG })
  await page.waitForTimeout(500)
  check('cropper: opens after choosing a photo', await page.getByRole('dialog', { name: 'Position your photo' }).isVisible())
  const stage = page.locator('.crop-stage'); const box = await stage.boundingBox()
  const before = await stage.locator('img').evaluate(i => i.style.transform)
  await page.mouse.move(box.x + 140, box.y + 140); await page.mouse.down(); await page.mouse.move(box.x + 60, box.y + 90, { steps: 5 }); await page.mouse.up()
  await page.locator('.crop-stage ~ label input[type=range], dialog input[type=range], [role=dialog] input[type=range]').first().fill('2.4')
  const after = await stage.locator('img').evaluate(i => i.style.transform + i.style.width)
  check('cropper: dragging and zooming move the picture', after !== before + (await stage.locator('img').evaluate(i => i.style.width)))
  await page.getByRole('button', { name: 'Use photo' }).click(); await page.waitForTimeout(900)
  const up = state.uploads.find(u => new RegExp(`/object/media/${ME}/`).test(u.path))
  check('cropper: uploads a square WebP (not the raw file) under your folder', Boolean(up) && up.path.endsWith('.webp') && up.size < 1_500_000, JSON.stringify(up))
  await ctx.close()
}

// ---------------------------------------------------------------- post images
{
  const { ctx, state } = await ctxWith(); const page = await ctx.newPage()
  await page.goto(BASE + '/app'); await page.waitForTimeout(900)
  const batch = state.calls.filter(c => c === 'POST /storage/v1/object/sign/media')
  check('images: avatars and photos are signed in ONE batch request per page of posts', batch.length >= 1 && !state.calls.some(c => /^POST \/storage\/v1\/object\/sign\/media\/.+/.test(c)), state.calls.filter(c => /storage/.test(c)).join(' | '))
  const fit = await page.locator('.igp-slide img').first().evaluate(i => getComputedStyle(i).objectFit)
  check('images: post photos use object-fit: contain (never cropped)', fit === 'contain')
  await ctx.close()
}

// ---------------------------------------------------------------- onboarding
{
  const { ctx, state } = await ctxWith({ profile: me({ onboarded_at: null, display_name: 'alice', interests: [] }) }); const page = await ctx.newPage()
  await page.goto(BASE + '/app'); await page.waitForTimeout(800)
  check('onboarding: new users land on step 1 on its own screen (no app navigation)', page.url().endsWith('/app/onboarding') && await page.locator('.hdr, .bottomnav').count() === 0 && await page.getByText('Step 1 of 7').isVisible())
  await page.fill('#bd', '2018-01-01'); await page.getByRole('checkbox').check()
  check('onboarding: under-13 cannot continue', await page.getByRole('button', { name: 'Continue' }).isDisabled() && await page.getByText(/13 and over/).isVisible())
  await page.fill('#bd', '1999-05-05'); await page.getByRole('button', { name: /Find things to do/ }).click(); await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForTimeout(500)
  check('onboarding: private facts go to profile_private, not the public profile', state.calls.some(c => c.includes('profile_private') && c.includes('birth_date')) && !state.calls.some(c => /PATCH profiles/.test(c) && c.includes('birth_date')))
  check('onboarding: step 2 (photo) shows and progress is saved', await page.getByText('Step 2 of 7').isVisible() && state.calls.some(c => /PATCH profiles/.test(c) && c.includes('onboarding_step')))
  await page.getByRole('button', { name: /Skip for now|Continue/ }).click(); await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Choose your city/ }).click(); await page.getByRole('dialog').getByText('Cape Town').first().click()
  await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForTimeout(400)
  check('onboarding: the city is saved as city-centre coordinates', state.calls.some(c => /PATCH profiles/.test(c) && c.includes('"lat":-33.9249') && c.includes('Cape Town')))
  await page.getByRole('button', { name: 'Music' }).click(); await page.getByRole('button', { name: /Continue \(1\)/ }).click(); await page.waitForTimeout(500)
  check('onboarding: step 5 suggests people and communities', await page.getByText('Step 5 of 7').isVisible())
  await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Continue' }).click(); await page.waitForTimeout(300)
  check('onboarding: final step offers to enter VYBE', await page.getByRole('button', { name: 'Go to VYBE' }).isVisible())
  await ctx.close()
}

// ---------------------------------------------------------------- sign-in → splash; many tabs
{
  const { ctx } = await ctxWith({ signedIn: false }); const page = await ctx.newPage()
  await page.goto(BASE + '/signin'); await page.waitForTimeout(400)
  check('splash: not shown on /signin itself', await page.locator('[data-testid=splash]').count() === 0)
  await page.fill('#login', 'alice@example.com'); await page.fill('#password', 'correct-horse'); await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForSelector('[data-testid=splash]', { timeout: 4000 }).catch(() => {})
  check('splash: plays after every successful sign-in', await page.locator('[data-testid=splash]').count() === 1 && /\/app/.test(page.url()))
  check('splash: shows the tagline under the logo', await page.locator('.splash-tag').innerText().then(t => t.includes('Life is better together')).catch(() => false))
  await ctx.close()
}
{
  const { ctx } = await ctxWith(); const tabs = await Promise.all([1, 2, 3].map(() => ctx.newPage()))
  await Promise.all(tabs.map((p, i) => p.goto(BASE + ['/app', '/app/discover', '/app/friends'][i])))
  await tabs[0].waitForTimeout(1500)
  check('tabs: three tabs stay signed in side by side', tabs.every((p, i) => p.url().endsWith(['/app', '/app/discover', '/app/friends'][i])))
  await tabs[0].reload(); await tabs[0].waitForTimeout(800); await tabs[1].bringToFront(); await tabs[1].waitForTimeout(500)
  check('tabs: reloading one does not sign the others out', tabs.every(p => !p.url().includes('/signin')))
  await ctx.close()
}

// ---------------------------------------------------------------- tickets
{
  const { ctx, state } = await ctxWith(); const page = await ctx.newPage()
  await page.goto(BASE + '/app/plans/e1'); await page.waitForTimeout(900)
  check('event: shows directions, lineup placeholder and tickets', await page.getByRole('link', { name: /Directions/ }).isVisible() && await page.getByText('General').first().isVisible())
  const href = await page.getByRole('link', { name: /Directions/ }).getAttribute('href')
  check('event: directions link targets the venue coordinates', /destination=-33\.92%2C18\.42/.test(href), href)
  await page.getByRole('button', { name: 'More General' }).click(); await page.getByRole('button', { name: 'More General' }).click()
  check('tickets: quantity stepper respects the live total', await page.getByText(/2 tickets · R/).isVisible())
  await page.getByRole('button', { name: 'Checkout' }).click()
  await page.getByText('Ozow').first().click()
  const navP = page.waitForRequest(r => r.url().startsWith('https://pay.ozow.com'), { timeout: 5000 }).catch(() => null)
  await page.getByRole('button', { name: 'Continue to payment' }).click()
  const req = await navP
  check('tickets: order is created server-side with ids and quantities only (no prices sent)', state.orders.length === 1 && JSON.stringify(state.orders[0].p_items) === JSON.stringify([{ ticket_type_id: 't1', qty: 2 }]) && state.orders[0].p_provider === 'ozow' && /^co-/.test(state.orders[0].p_idem))
  check('tickets: browser is handed to the provider with a form POST', Boolean(req) && req.method() === 'POST' && (req.postData() ?? '').includes('HashCheck=abc'))
  await ctx.close()
  const f = await ctxWith({ pay: 'down' }); const p2 = await f.ctx.newPage()
  await p2.goto(BASE + '/app/plans/e1'); await p2.waitForTimeout(800)
  await p2.getByRole('button', { name: 'More General' }).click(); await p2.getByRole('button', { name: 'Checkout' }).click(); await p2.getByRole('button', { name: 'Continue to payment' }).click(); await p2.waitForTimeout(700)
  check('tickets: if payment cannot start, the error is shown and the held order is cancelled', await p2.getByRole('alert').filter({ hasText: /not configured/ }).isVisible() && f.state.calls.includes('rpc cancel_my_order'))
  await f.ctx.close()
}

// ---------------------------------------------------------------- live streaming (UI against the token function)
{
  const { ctx, state } = await ctxWith({ live: 'ticket' }); const page = await ctx.newPage()
  await page.goto(BASE + '/app/live'); await page.waitForTimeout(800)
  check('live: viewers see Watch, hosts see Go live', await page.getByRole('link', { name: 'Watch' }).isVisible() && await page.getByRole('link', { name: 'Go live' }).isVisible())
  await page.goto(BASE + '/app/live/s1'); await page.waitForTimeout(1200)
  check('live: the token function is asked (as a viewer) as soon as the page opens', state.calls.some(c => c.startsWith('fn livekit-token') && c.includes('"publish":false')))
  check('live: a ticket-gated stream explains why and links to the tickets', await page.getByText('You need a ticket for this event to watch').isVisible() && await page.getByRole('link', { name: 'Get tickets' }).isVisible())
  await page.goto(BASE + '/app/live/s2/host'); await page.waitForTimeout(800)
  check('live: the host sees a pre-flight screen and nothing is published until they press Go live', await page.getByRole('button', { name: 'Go live' }).isVisible() && !state.calls.some(c => c.startsWith('fn livekit-token') && c.includes('s2')))
  await page.getByRole('button', { name: 'Go live' }).click(); await page.waitForTimeout(800)
  check('live: pressing Go live requests a PUBLISH token', state.calls.some(c => c.startsWith('fn livekit-token') && c.includes('"publish":true')))
  check('live: if the token is refused the host gets a clear message and a retry', await page.getByRole('alert').isVisible() && await page.getByRole('button', { name: /Try again|Get tickets/ }).first().isVisible())
  await page.goto(BASE + '/app/live/s1/host'); await page.waitForTimeout(700)
  check('live: non-hosts are sent to the watch page, not the host page', page.url().endsWith('/app/live/s1'))
  await ctx.close()
}

// ---------------------------------------------------------------- refunds + receipts
{
  const { ctx, state } = await ctxWith(); const page = await ctx.newPage()
  await page.goto(BASE + '/app/orders/o1'); await page.waitForTimeout(800)
  check('orders: a paid order offers a receipt and a refund request', await page.getByRole('link', { name: 'Receipt' }).isVisible() && await page.getByRole('button', { name: 'Request a refund' }).isVisible())
  await page.getByRole('button', { name: 'Request a refund' }).click(); await page.getByRole('textbox').fill('plans changed')
  await page.getByRole('button', { name: 'Request refund' }).click(); await page.waitForTimeout(800)
  check('refunds: the request goes to the database, then an approved refund is sent to the refund function', state.calls.includes('rpc request_refund') && state.calls.some(c => c.startsWith('fn refund-process') && c.includes('rf-1')))
  await ctx.close()
  const w = await ctxWith({ refundStatus: 'requested' }); const p2 = await w.ctx.newPage()
  await p2.goto(BASE + '/app/orders/o1'); await p2.getByRole('button', { name: 'Request a refund' }).click(); await p2.getByRole('button', { name: 'Request refund' }).click(); await p2.waitForTimeout(800)
  check('refunds: outside the self-service window it waits for the organizer (no gateway call)', !w.state.calls.some(c => c.startsWith('fn refund-process')))
  await w.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall feature checks passed')
process.exit(failures ? 1 : 0)
