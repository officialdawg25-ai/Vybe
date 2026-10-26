// Browser checks for VYBE Tickets screens added with migration 28, against a MOCKED backend: promoter links, exports and
// material-change notices for organisers; reviews, complaints and promoter attribution for buyers; payout holds with
// appeal; promoter earnings; and Admin → Tickets & Trust → Risk / Complaints & reviews. Behaviour and exact calls only;
// the database rules are tested in tests/db. Build with VITE_SUPABASE_URL=https://mock.supabase.test; SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const SHOTS = process.env.SHOTS
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', EV = 'cccccccc-0000-4000-8000-000000000001', TT = 'dddddddd-0000-4000-8000-000000000001', FREE = 'dddddddd-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 9 * 86400_000).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const event = review => ({ material_change_at: review.changed ? now : null, material_change_note: review.changed ? 'Venue changed.' : null, id: EV, host: review.host ?? ME, title: 'Graduation party', description: 'Caps in the air.', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Rooftop', visibility: 'public', capacity: null, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', format: 'in_person', organization_id: null, city: 'Johannesburg', venue: 'The Rooftop', sales_review: review.status, sales_review_note: review.note ?? '', profiles: { id: review.host ?? ME, username: 'alice', display_name: 'Alice', avatar_path: null } })
const types = [{ id: TT, event_id: EV, name: 'General', description: '', kind: 'single', group_size: 1, price_cents: 15000, currency: 'ZAR', quantity_total: 100, max_per_order: 4, sales_start: null, sales_end: null, status: 'active', sort: 0 },
  { id: FREE, event_id: EV, name: 'Guest list', description: '', kind: 'single', group_size: 1, price_cents: 0, currency: 'ZAR', quantity_total: 50, max_per_order: 2, sales_start: null, sales_end: null, status: 'active', sort: 1 }]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) }

async function open(url, w = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
  const seen = { rpc: [] }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    const p = u.pathname
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length); seen.rpc.push({ fn, args: body() })
      if (fn === 'my_profile') return json(me)
      if (fn === 'is_admin' || fn === 'is_staff') return json(Boolean(w.admin))
      if (fn === 'can_manage_event') return json(Boolean(w.manage))
      if (fn === 'can_scan_event') return json(true)
      if (fn === 'ticket_units_taken') return json(3)
      if (fn === 'event_fee_terms') return json({ name: 'Platform v1 (launch terms)', scope: 'platform', commission_bps: 0, commission_fixed_cents: 0, commission_per_ticket_cents: 0, buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300, buyer_fee_per_ticket_cents: 0 })
      if (fn === 'admit_ticket') { const c = body()?.p_code ?? ''; return json(c.endsWith('GOOD') ? { result: 'ok', ticket_type: 'General', holder: 'Thandi' } : c.endsWith('USED') ? { result: 'already_used', ticket_type: 'General', holder: 'Thandi', used_at: now } : { result: 'wrong_event' }) }
      if (fn === 'admin_ticket_finance') return json({ basis: 'Double-entry journal: provider-confirmed payments, completed refunds, recorded payouts. Pending checkouts are excluded.', collected_cents: 1605000, gross_ticket_sales_cents: 1500000, commission_revenue_cents: 0, buyer_fee_revenue_cents: 105000, vat_on_platform_charges_cents: 0, refunds_paid_cents: 16050, chargebacks_cents: 0, chargeback_losses_cents: 0, payouts_completed_cents: 0, net_platform_contribution_cents: 105000, processing_costs: 'Not recorded: provider fees are not yet imported from PayFast/Ozow statements.', balances: { cash_held_cents: 1588950, organizer_payable_cents: 1485000, refunds_owed_cents: 0, vat_payable_cents: 0 }, open_refund_obligations_cents: 0, open_exceptions: 1, events_awaiting_review: 1 })
      if (fn === 'finance_reconcile') return json({ open_exceptions: 1, new_exceptions: 0, expired_orders: 2 })
      if (fn === 'admin_review_event_sales') return json(body()?.p_decision)
      if (fn === 'event_review_summary') return json(w.reviews ? { count: 3, verified: 2, average: 4.3 } : { count: 0, verified: 0, average: null })
      if (fn === 'review_eligibility') return json(w.eligible ? { eligible: true, verified_attendee: true } : { eligible: false, reason: w.manage ? 'organiser' : 'no_ticket' })
      if (fn === 'create_promoter_link') return json({ id: 'pl2', code: 'ZX98YW76', commission_bps: body()?.p_commission_bps })
      if (fn === 'event_sales_export') return json([{ order: 'abcd1234', created_at: now, paid_at: now, status: 'paid', provider: 'payfast', tickets: 1, ticket_subtotal_cents: 15000, buyer_fee_cents: 1050, commission_cents: 0, organizer_net_cents: 15000, refunded_cents: 0, promoter_code: 'AB12CD34' }])
      if (fn === 'event_door_list') return json([{ holder: 'Thandi', ticket_type: 'General', status: 'valid', checked_in_at: null }])
      if (fn === 'declare_material_change') return json(7)
      if (fn === 'my_payout_holds') return json(w.hold ? [{ id: 9, since: now, status: 'open', appealed: false }] : [])
      if (fn === 'payout_balance') return json({ available_cents: 250000, gross_sales_cents: 300000, refunds_and_chargebacks_cents: 0, paid_out_cents: 0, pending_payout_cents: 0, hold_days: 3, min_payout_cents: 10000, open_disputes_cents: 0 })
      if (fn === 'my_promoter_earnings') return json([{ link: 'pl1', code: 'AB12CD34', event_id: EV, event: 'Graduation party', commission_bps: 1000, active: true, orders: 2, earned_cents: 3000 }])
      if (fn === 'create_order') return json({ code: 'P0001', message: 'stop here (mock)' }, 400)
      if (fn === 'buyer_fee_terms') return json(w.buyerFee ? { buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300, buyer_fee_per_ticket_cents: 0 } : { buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 })
      return json(null)
    }
    if (p === '/rest/v1/events') {
      if (u.searchParams.get('sales_review')) return json([{ ...event({ status: 'submitted' }), host: 'bbbbbbbb-0000-4000-8000-000000000002', profiles: { username: 'nightco', display_name: 'Night Co' }, organizations: null }])
      return json(obj ? event({ status: w.review ?? 'not_submitted', note: w.note, host: w.host, changed: w.changed }) : [event({ status: w.review ?? 'not_submitted', note: w.note, host: w.host, changed: w.changed })])
    }
    if (p === '/rest/v1/ticket_types') return u.searchParams.has('price_cents') ? route.fulfill({ status: 200, headers: { ...h, 'content-range': '0-0/1' }, body: '' }) : json(types)
    if (p === '/rest/v1/event_evidence') return json(w.evidence ?? [])
    if (p === '/rest/v1/event_sales_decisions') return json([{ id: 1, from_status: 'not_submitted', to_status: 'submitted', reason: '', created_at: now }])
    if (p === '/rest/v1/event_staff') return json([{ user_id: 'x', role: 'scanner', profiles: { username: 'doorbob', display_name: 'Bob' } }])
    if (p === '/rest/v1/event_lineup') return json([{ id: 'l1', name: 'DJ Fresh', role: 'Headliner', bio: '', image_path: null, sort: 0, status: 'confirmed', status_note: '' }, { id: 'l2', name: 'Surprise guest', role: 'Guest', bio: '', image_path: null, sort: 1, status: 'pending', status_note: '' }])
    if (p === '/rest/v1/fee_policies') return json([{ id: 'f1', scope: 'platform', organization_id: null, event_id: null, name: 'Platform v1 (launch terms)', commission_bps: 0, commission_fixed_cents: 0, commission_per_ticket_cents: 0, buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300, buyer_fee_per_ticket_cents: 0, effective_from: '2026-10-19T00:00:00Z', retired_at: null, note: 'Migrated', created_at: now }])
    if (p === '/rest/v1/reconciliation_exceptions') return json(u.searchParams.get('status') === 'eq.open' ? [{ id: 1, kind: 'paid_after_expiry_soldout', ref_key: 'o1', severity: 'high', order_id: 'eeeeeeee-0000-4000-8000-000000000001', refund_id: null, payout_id: null, detail: { total_cents: 16050 }, status: 'open', resolution: '', created_at: now }] : [])
    if (p === '/rest/v1/payment_notifications') return json([{ id: 1, provider: 'payfast', provider_txn_id: '1089250', reported_status: 'COMPLETE', order_ref: 'eeeeeeee-0000', amount_cents: 16050, outcome: 'fulfilled', times_seen: 2, last_seen_at: now }])
    if (p === '/rest/v1/promoter_links') return json([{ id: 'pl1', promoter: 'p1', code: 'AB12CD34', commission_bps: 1000, active: true, created_at: now, profiles: { username: 'promo', display_name: 'Promo' } }])
    if (p === '/rest/v1/referral_attributions') return json([{ link_id: 'pl1', commission_cents: 1500, reversed_cents: 0 }])
    if (p === '/rest/v1/event_reviews') return json(w.reviews ? [{ id: 'r1', event_id: EV, author: 'u9', rating: 5, body: 'Loved it.', verified_attendee: true, status: 'published', moderation_note: '', organiser_response: w.manage ? '' : 'Thank you!', responded_at: null, created_at: now, profiles: { username: 'zee', display_name: 'Zee' }, events: { title: 'Graduation party' } }] : [])
    if (p === '/rest/v1/event_complaints') return json(w.complaints ? [{ id: 'c1', event_id: EV, author: w.manage ? 'u9' : ME, order_id: 'eeeeeeee-0000-4000-8000-000000000001', subject: 'Queue too long', body: 'Waited two hours outside.', status: u.searchParams.get('status') === 'eq.escalated' ? 'escalated' : 'open', organiser_reply: '', replied_at: null, resolution: '', created_at: now, profiles: { username: 'zee', display_name: 'Zee' }, events: { title: 'Graduation party' } }] : [])
    if (p === '/rest/v1/orders' && r.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...h, 'content-range': w.holder ? '0-0/1' : '*/0' }, body: '' })
    if (p === '/rest/v1/risk_cases') return json([{ id: 5, rule_key: 'refund_rate_high', subject_type: 'organization', subject_id: 'ffffffff-0000-4000-8000-000000000001', action: 'PAUSE_PAYOUT', status: 'appealed', evidence: { refund_rate_pct: 42, paid_orders: 12 }, appeal: 'The headliner cancelled; we refunded everyone.', decision_note: '', created_at: now, decided_at: null }])
    if (p === '/rest/v1/risk_rules') return json([{ key: 'refund_rate_high', description: 'Refunds (percent of paid orders, at least 10 orders) above the threshold. Payouts hold until reviewed.', enabled: true, threshold: 30, window_minutes: 0, action: 'PAUSE_PAYOUT', updated_at: now }])
    if (p === '/rest/v1/profiles') return json(obj ? me : [me])
    if (p.startsWith('/rest/v1/tickets')) return r.method() === 'HEAD' ? route.fulfill({ status: 200, headers: { ...h, 'content-range': '*/0' }, body: '' }) : json([{ status: 'used' }, { status: 'valid' }])
    if (p.startsWith('/functions/v1/')) return json({ ok: true })
    return json(obj ? null : [])
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}

const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'
const rpcArgs = (t, fn) => t.seen.rpc.filter(x => x.fn === fn).map(x => x.args)

// 1. Organiser: promoter links, exports, material change, complaint replies, review replies.
{
  const t = await open(`/app/plans/${EV}`, { manage: true, review: 'approved', reviews: true, complaints: true })
  await t.page.waitForSelector('#ot-h', { timeout: 15000 }); await t.page.waitForTimeout(500); await shot(t.page, '10-organiser-tools')
  const text = await t.page.locator('main').innerText()
  check('promoter link listed with orders and earnings', /@promo/.test(text) && /Code AB12CD34 · 1 orders · R\s?15,00 earned/.test(text.replace(/ /g, ' ')), text.match(/Code AB12CD34[^\n]*/)?.[0])
  await t.page.fill('#pr-user', '@newpromo'); await t.page.fill('#pr-pct', '12.5'); await t.page.getByRole('button', { name: 'Create link' }).click(); await t.page.waitForTimeout(300)
  check('creating a link sends the share in basis points', JSON.stringify(rpcArgs(t, 'create_promoter_link')[0]) === JSON.stringify({ p_event: EV, p_username: '@newpromo', p_commission_bps: 1250 }), JSON.stringify(rpcArgs(t, 'create_promoter_link')))
  await t.page.fill('#pr-pct', '31'); check('more than 30 % is refused before sending', await t.page.getByText('The most a promoter can get is 30 %.').isVisible() && await t.page.getByRole('button', { name: 'Create link' }).isDisabled())
  const [dl] = await Promise.all([t.page.waitForEvent('download'), t.page.getByRole('button', { name: /Sales \(CSV\)/ }).click()])
  const csv = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8')
  check('sales export downloads exact rand amounts and the promoter code, no contact details', /^Order,Created/.test(csv) && /,150\.00,10\.50,0\.00,150\.00,0\.00,AB12CD34$/m.test(csv) && !/@|phone|email/i.test(csv), csv.split('\n')[1])
  const [dl2] = await Promise.all([t.page.waitForEvent('download'), t.page.getByRole('button', { name: /Door list \(CSV\)/ }).click()])
  check('door list export', /Thandi,General,valid/.test(await (await import('node:fs/promises')).readFile(await dl2.path(), 'utf8')))
  await t.page.getByRole('button', { name: /Tell ticket holders about a change/ }).click()
  await t.page.fill('#mc-note', 'Moved to the Main Hall.'); await t.page.getByRole('button', { name: 'Send to ticket holders' }).click(); await t.page.waitForTimeout(300)
  check('material change is declared with the note', rpcArgs(t, 'declare_material_change')[0]?.p_note === 'Moved to the Main Hall.')
  const cmp = await t.page.locator('section[aria-labelledby="cmp-h"]').innerText()
  check('organiser sees complaints with the buyer and order', /Queue too long/.test(cmp) && /Zee/.test(cmp) && /order eeeeeeee/.test(cmp))
  await t.page.getByLabel('Reply to this complaint').fill('Sorry — we are adding a second entrance.'); await t.page.locator('section[aria-labelledby="cmp-h"]').getByRole('button', { name: 'Send' }).click(); await t.page.waitForTimeout(300)
  check('complaint reply is sent', rpcArgs(t, 'reply_complaint')[0]?.p_complaint === 'c1')
  await t.page.locator('section[aria-labelledby="rev-h"]').getByRole('button', { name: 'Reply' }).click()
  await t.page.getByLabel('Your public reply').fill('Thanks for coming!'); await t.page.getByRole('button', { name: 'Post reply' }).click(); await t.page.waitForTimeout(300)
  check('organiser can answer a review publicly', rpcArgs(t, 'respond_to_review')[0]?.p_text === 'Thanks for coming!')
  check('organiser is not offered a review form', !(await t.page.getByRole('button', { name: /Review this event/ }).count()))
  check('no page errors (organiser)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. Attendee after the event: review summary, write a review, own complaint and escalation, material-change notice.
{
  const t = await open(`/app/plans/${EV}`, { host: OTHER, review: 'approved', reviews: true, eligible: true, complaints: true, holder: true, changed: true })
  await t.page.waitForSelector('#rev-h', { timeout: 15000 }); await t.page.waitForTimeout(500); await shot(t.page, '11-attendee-reviews')
  const rev = await t.page.locator('section[aria-labelledby="rev-h"]').innerText()
  check('summary shows the average, count and attended count', /4\.3/.test(rev) && /3 reviews/.test(rev) && /2 attended/.test(rev), rev.slice(0, 120))
  check('verified attendee badge and organiser reply are shown', /Attended/.test(rev) && /Organiser: Thank you!/.test(rev))
  check('material change notice tells buyers about refunds', /Venue changed\. If you bought before this, you can get your money back/.test(await t.page.locator('main').innerText()))
  await t.page.getByRole('button', { name: /Review this event/ }).click()
  await t.page.getByRole('button', { name: 'Post review' }).click()
  check('a rating is required', await t.page.getByText('Choose a rating.').isVisible())
  await t.page.getByRole('radio', { name: '4 out of 5' }).click(); await t.page.fill('#rev-body', 'Great sound, long queue.'); await shot(t.page, '12-review-form')
  await t.page.getByRole('button', { name: 'Post review' }).click(); await t.page.waitForTimeout(300)
  check('review is submitted with rating and text', JSON.stringify(rpcArgs(t, 'submit_event_review')[0]) === JSON.stringify({ p_event: EV, p_rating: 4, p_body: 'Great sound, long queue.' }))
  const cmp = await t.page.locator('section[aria-labelledby="cmp-h"]').innerText()
  check('buyer sees their complaint and its state', /Queue too long/.test(cmp) && /Waiting for the organiser/.test(cmp))
  await t.page.getByRole('button', { name: /Ask VYBE to look/ }).click(); await t.page.waitForTimeout(300)
  check('buyer can escalate to VYBE', rpcArgs(t, 'escalate_complaint')[0]?.p_complaint === 'c1')
  check('no page errors (attendee)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 3. Someone with no ticket: no review form, no complaint form.
{
  const t = await open(`/app/plans/${EV}`, { host: OTHER, review: 'approved', reviews: true })
  await t.page.waitForSelector('#rev-h', { timeout: 15000 }); await t.page.waitForTimeout(500)
  check('non-holder cannot review or complain', !(await t.page.getByRole('button', { name: /Review this event/ }).count()) && !(await t.page.locator('#cmp-h').count()))
  await t.ctx.close()
}

// 4. Promoter link: ?ref= is remembered and sent with the order.
{
  const t = await open(`/app/plans/${EV}?ref=AB12CD34`, { host: OTHER, review: 'approved' })
  await t.page.getByRole('button', { name: 'More General' }).click({ timeout: 15000 })
  await t.page.getByRole('button', { name: 'Checkout' }).click(); await t.page.getByRole('button', { name: 'Continue to payment' }).click(); await t.page.waitForTimeout(500)
  check('checkout passes the promoter code', rpcArgs(t, 'create_order')[0]?.p_ref === 'AB12CD34', JSON.stringify(rpcArgs(t, 'create_order')[0]))
  await t.ctx.close()
}

// 4b. Checkout shows the full price before paying: no fee under the organiser-commission terms; exact fee and total otherwise.
for (const [buyerFee, want] of [[false, /Total\s*R\s?150,00[\s\S]*No booking fee: you pay the ticket price/], [true, /Service fee\s*R\s?10,50[\s\S]*Total\s*R\s?160,50/]]) {
  const t = await open(`/app/plans/${EV}`, { host: OTHER, review: 'approved', buyerFee })
  await t.page.getByRole('button', { name: 'More General' }).click({ timeout: 15000 })
  await t.page.getByRole('button', { name: 'Checkout' }).click(); await t.page.waitForTimeout(500); await shot(t.page, `16-checkout-${buyerFee ? 'fee' : 'nofee'}`)
  const text = (await t.page.locator('[role="dialog"]').innerText()).replace(/\u00a0/g, ' ')
  check(`checkout total ${buyerFee ? 'with a buyer fee' : 'under organiser commission'}`, want.test(text), text.slice(0, 160))
  await t.ctx.close()
}
{
  const t = await open(`/app/plans/${EV}?ref=bad`, { host: OTHER, review: 'approved' })
  await t.page.getByRole('button', { name: 'More General' }).click({ timeout: 15000 })
  await t.page.getByRole('button', { name: 'Checkout' }).click(); await t.page.getByRole('button', { name: 'Continue to payment' }).click(); await t.page.waitForTimeout(500)
  check('a malformed code is ignored (4-argument order)', rpcArgs(t, 'create_order')[0] && !('p_ref' in rpcArgs(t, 'create_order')[0]))
  await t.ctx.close()
}

// 5. Earnings: payout hold with appeal, promoter earnings.
{
  const t = await open('/app/earnings', { hold: true })
  await t.page.waitForSelector('[aria-label="Payout hold"]', { timeout: 15000 }); await t.page.waitForTimeout(300); await shot(t.page, '13-payout-hold')
  const text = await t.page.locator('main').innerText()
  check('hold explained without naming the rule', /Payouts are on hold while VYBE checks recent activity/.test(text) && !/refund_rate|PAUSE_PAYOUT/.test(text))
  await t.page.getByLabel('Explain what happened').fill('Headliner cancelled, so we refunded.'); await t.page.locator('[aria-label="Payout hold"]').getByRole('button', { name: 'Send' }).click(); await t.page.waitForTimeout(300)
  check('appeal is sent', JSON.stringify(rpcArgs(t, 'appeal_payout_hold')[0]) === JSON.stringify({ p_case: 9, p_text: 'Headliner cancelled, so we refunded.' }))
  check('promoter earnings listed', /As a promoter/.test(text) && /Code AB12CD34 · 10 % · 2 orders/.test(text) && /R\s?30,00/.test(text.replace(/ /g, ' ')))
  check('no page errors (earnings)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 6. Admin: risk case with appeal and enforced action, rule tuning, escalated complaints, review moderation.
{
  const t = await open('/admin/trust?tab=risk', { admin: true, reviews: true, complaints: true })
  await t.page.waitForSelector('text=refund rate high', { timeout: 15000 }); await t.page.waitForTimeout(300); await shot(t.page, '14-admin-risk')
  const text = await t.page.locator('main').innerText()
  check('risk case shows rule, evidence, appeal and what it blocks', /PAUSE_PAYOUT · Payouts held while open/.test(text) && /refund_rate_pct/.test(text) && /Appeal: The headliner cancelled/.test(text))
  check('decisions need a reason', await t.page.getByRole('button', { name: 'Dismiss' }).isDisabled())
  await t.page.getByLabel('Reason for the decision').fill('Genuine cancellation; refunds were correct.'); await t.page.getByRole('button', { name: 'Dismiss' }).click(); await t.page.waitForTimeout(300)
  check('case decision sent', JSON.stringify(rpcArgs(t, 'admin_decide_risk_case')[0]) === JSON.stringify({ p_case: 5, p_status: 'dismissed', p_note: 'Genuine cancellation; refunds were correct.' }))
  await t.page.locator('.item', { hasText: 'Refunds (percent' }).getByLabel(/Threshold/).fill('40'); await t.page.locator('.item', { hasText: 'Refunds (percent' }).getByRole('button', { name: 'Save' }).click(); await t.page.waitForTimeout(300)
  check('rule threshold saved', JSON.stringify(rpcArgs(t, 'admin_set_risk_rule')[0]) === JSON.stringify({ p_key: 'refund_rate_high', p_enabled: true, p_threshold: 40, p_window: 0, p_action: 'PAUSE_PAYOUT' }))
  await t.page.getByRole('tab', { name: /Complaints & reviews/ }).or(t.page.getByRole('button', { name: /Complaints & reviews/ })).first().click(); await t.page.waitForSelector('text=Escalated complaints'); await t.page.waitForTimeout(300); await shot(t.page, '15-admin-feedback')
  await t.page.getByLabel('Resolution').fill('Partial refund agreed with the organiser.'); await t.page.getByRole('button', { name: 'Close' }).click(); await t.page.waitForTimeout(300)
  check('escalated complaint closed with a resolution', rpcArgs(t, 'admin_close_complaint')[0]?.p_resolution === 'Partial refund agreed with the organiser.')
  check('hiding a review needs a reason', await t.page.getByRole('button', { name: 'Hide' }).isDisabled())
  await t.page.getByLabel('Moderation reason').fill('Contains a phone number.'); await t.page.getByRole('button', { name: 'Hide' }).click(); await t.page.waitForTimeout(300)
  check('review hidden with the reason', JSON.stringify(rpcArgs(t, 'admin_moderate_review')[0]) === JSON.stringify({ p_review: 'r1', p_status: 'hidden', p_note: 'Contains a phone number.' }))
  check('no page errors (admin)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
