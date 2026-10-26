// Browser checks for the branded ticketing UX (migration 32), against a MOCKED backend: tiered ticket stubs, the host
// trust card, the RSVP panel, the premium checkout with official payment marks and the hand-over, the payment success
// screen with the tickets and their branded QR (decoded here with jsQR, like the door scanner), and My tickets.
// Build with VITE_SUPABASE_URL=https://mock.supabase.test; SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const jsqrSrc = readFileSync(createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js'), 'utf8')

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const SHOTS = process.env.SHOTS
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', EV = 'cccccccc-0000-4000-8000-000000000001', TT = 'dddddddd-0000-4000-8000-000000000001', FREE = 'dddddddd-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 9 * 86400_000).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const event = review => ({ material_change_at: review.changed ? now : null, material_change_note: review.changed ? 'Venue changed.' : null, id: EV, host: review.host ?? ME, title: 'Graduation party', description: 'Caps in the air.', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Rooftop', visibility: 'public', capacity: null, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', format: 'in_person', organization_id: null, city: 'Johannesburg', venue: 'The Rooftop', sales_review: review.status, sales_review_note: review.note ?? '', profiles: { id: review.host ?? ME, username: 'alice', display_name: 'Alice', avatar_path: null } })
const VIP = 'dddddddd-0000-4000-8000-000000000003', VVIP = 'dddddddd-0000-4000-8000-000000000004', ORDER = 'eeeeeeee-0000-4000-8000-000000000009', CODE = '5FE12DA80412EE7F0C3E'
const types = [{ id: TT, event_id: EV, name: 'General', description: 'General Access', kind: 'single', group_size: 1, price_cents: 15000, currency: 'ZAR', quantity_total: 100, max_per_order: 4, sales_start: null, sales_end: null, status: 'active', sort: 0, tier: 'general', accent: null, design: 'aurora', perks: [] },
  { id: VIP, event_id: EV, name: 'VIP', description: '', kind: 'single', group_size: 1, price_cents: 50000, currency: 'ZAR', quantity_total: 40, max_per_order: 4, sales_start: null, sales_end: null, status: 'active', sort: 1, tier: 'vip', accent: null, design: 'foil', perks: ['Fast lane', 'Free drink', 'VIP deck'] },
  { id: VVIP, event_id: EV, name: 'VVIP Table', description: '', kind: 'single', group_size: 1, price_cents: 120000, currency: 'ZAR', quantity_total: 8, max_per_order: 2, sales_start: null, sales_end: null, status: 'active', sort: 2, tier: 'vvip', accent: null, design: 'mesh', perks: ['Private booth', 'Bottle service'] }]

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
    if (r.method() === 'PATCH') { (seen.patches ??= []).push({ path: p, body: body() }); return json([]) }
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
      if (fn === 'create_order') return json({ id: ORDER, status: 'pending', total_cents: 50000, fee_cents: 0, subtotal_cents: 50000, expires_at: later })
      if (fn === 'host_reputation') return json({ member_since: '2025-03-02T10:00:00Z', verified: true, plans: 14, past_plans: 11, cancelled: 0, people_went: 860, reviews: 23, rating: 4.7, approved_for_sales: true, followers: 1240 })
      if (fn === 'event_social') return json({ going: 38, interested: 12, saved: false, mine: w.mine ? { status: w.mine, visibility: 'friends' } : null, people: [
        { id: 'f1', username: 'thandi', display_name: 'Thandi M', avatar_path: null, status: 'going', friend: true }, { id: 'f2', username: 'sipho', display_name: 'Sipho K', avatar_path: null, status: 'going', friend: true },
        { id: 'f3', username: 'lee', display_name: 'Lee', avatar_path: null, status: 'going', friend: false }] })
      if (fn === 'my_ticket_code') return json(CODE)
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
    if (p === '/rest/v1/orders' && r.method() === 'GET' && u.searchParams.get('id')) { const o = { id: ORDER, status: w.orderStatus ?? 'paid', total_cents: 50000, fee_cents: 0, subtotal_cents: 50000, provider: 'payfast', event_id: EV, created_at: now, paid_at: now,
      events: { id: EV, title: 'Graduation party', starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', venue: 'The Rooftop', address: '1 Main Rd', city: 'Johannesburg', online_url: null } }; return json(obj ? o : [o]) }
    if (p.startsWith('/rest/v1/tickets') && r.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...h, 'content-range': '*/0' }, body: '' })
    if (p.startsWith('/rest/v1/tickets') && u.searchParams.get('order_id')) return json([{ id: 't1', status: 'valid', ticket_types: types[1] }])
    if (p.startsWith('/rest/v1/tickets') && u.searchParams.get('owner')) return json([{ id: 't1', status: 'valid', transfers: 0, event_id: EV, events: { id: EV, title: 'Graduation party', starts_at: later, timezone: 'Africa/Johannesburg', venue: 'The Rooftop', city: 'Johannesburg' }, ticket_types: types[1] },
      { id: 't2', status: 'used', transfers: 1, event_id: EV, events: { id: EV, title: 'Graduation party', starts_at: later, timezone: 'Africa/Johannesburg', venue: 'The Rooftop', city: 'Johannesburg' }, ticket_types: types[0] }])
    if (p.startsWith('/rest/v1/tickets')) return json([{ status: 'used' }, { status: 'valid' }])
    if (p === '/functions/v1/pay-start') return json({ action: 'https://sandbox.payfast.co.za/eng/process', method: 'POST', fields: { merchant_id: '10000100', m_payment_id: ORDER } })
    if (p.startsWith('/functions/v1/')) return json({ ok: true })
    return json(obj ? null : [])
  })
  await ctx.route('https://sandbox.payfast.co.za/**', route => { seen.payfast = route.request().postData(); return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayFast sandbox (mock)</h1>' }) })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}

const rpcArgs = (t, fn) => t.seen.rpc.filter(x => x.fn === fn).map(x => x.args)

const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002'

// 1. Event page: tiered tickets, host trust card, RSVP panel.
{
  const t = await open(`/app/plans/${EV}`, { host: OTHER, review: 'approved' })
  await t.page.waitForSelector('.tk', { timeout: 15000 }); await t.page.waitForTimeout(600); await shot(t.page, '20-event-tiers')
  const tiers = await t.page.locator('.tix .tk').evaluateAll(n => n.map(x => x.getAttribute('data-tier')))
  check('ticket types render as branded tier stubs', JSON.stringify(tiers) === JSON.stringify(['general', 'vip', 'vvip']), JSON.stringify(tiers))
  check('VIP perks are shown on the ticket', /Fast lane[\s\S]*Free drink/.test(await t.page.locator('.tk[data-tier="vip"]').innerText()))
  const host = await t.page.locator('.host-card').innerText()
  check('host card shows track record, rating, followers and VYBE checks', /14\s*plans hosted/.test(host) && /860\s*people went/.test(host) && /★ 4.7/.test(host) && /1.2K\s*followers/i.test(host) && /Checked by VYBE for ticket sales/.test(host) && /No cancelled plans/.test(host), host.replace(/\n/g, ' | ').slice(0, 260))
  check('follow is one tap from the host card', await t.page.locator('.host-card').getByRole('button', { name: /Follow/ }).isVisible())
  await t.page.locator('.rsvp').scrollIntoViewIfNeeded(); await shot(t.page, '21-rsvp')
  const rsvp = await t.page.locator('.rsvp').innerText()
  check('RSVP shows friends going and a countdown', /Thandi, Sipho and 36 others are going/.test(rsvp) && /⏳/.test(rsvp), rsvp.replace(/\n/g, ' | ').slice(0, 200))
  await t.page.getByRole('button', { name: /I’m going/ }).click(); await t.page.waitForTimeout(300)
  check('tapping going plays the burst and records the RSVP', (await t.page.locator('.rsvp-burst i').count()) === 12 && t.seen.rest?.some?.(() => true) !== false)
  check('no page errors (event)', t.errors.length === 0, t.errors.join(' | '))

  // 2. Checkout: official payment marks, full price, hand-over to PayFast.
  await t.page.getByRole('button', { name: 'More VIP' }).click()
  await t.page.getByRole('button', { name: /Checkout/ }).click(); await t.page.waitForTimeout(600); await shot(t.page, '22-checkout')
  const dlg = t.page.locator('[role="dialog"]')
  const co = (await dlg.innerText()).replace(/ /g, ' ')
  check('checkout shows the VIP stub, no booking fee and the total', /VIP/.test(co) && /Booking fee\s*None/.test(co) && /Total\s*R\s?500,00/.test(co), co.slice(0, 200))
  const pf = await dlg.locator('img[alt="PayFast"]').evaluate(img => ({ ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth }))
  check('official PayFast logo loads', pf.ok, JSON.stringify(pf))
  check('card network marks are shown', await dlg.getByRole('img', { name: 'Visa' }).isVisible() && await dlg.getByRole('img', { name: 'Mastercard' }).isVisible())
  check('Ozow falls back to its name when no logo file is present', await dlg.locator('.pm-word').count() === 1 || await dlg.locator('img[alt="Ozow"]').count() === 1)
  await dlg.getByRole('button', { name: /Pay R\s?500,00 securely/ }).click()
  await t.page.waitForSelector('.co-hand', { timeout: 5000 }); await shot(t.page, '23-handover')
  check('branded hand-over shows while the order is reserved', /Securing your tickets|Opening PayFast/.test(await t.page.locator('.co-hand').innerText()))
  await t.page.waitForURL(/sandbox\.payfast\.co\.za/, { timeout: 8000 }).catch(() => {})
  check('then the signed form is posted to PayFast', /m_payment_id=/.test(t.seen.payfast ?? ''), String(t.seen.payfast))
  await t.ctx.close()
}

// 3. Payment success: branded hero, tickets with a branded QR that decodes, actions.
{
  const t = await open(`/app/orders/${ORDER}`, { orderStatus: 'paid' })
  await t.page.waitForSelector('.pay-hero.ok', { timeout: 15000 }); await t.page.waitForSelector('img.bqr', { timeout: 8000 }); await t.page.waitForTimeout(900); await shot(t.page, '24-success')
  const hero = await t.page.locator('.pay-hero').innerText()
  check('success hero says payment successful and names the event', /Payment successful/i.test(hero) && /You’re going to\s*Graduation party/.test(hero), hero.replace(/\n/g, ' | '))
  await t.page.addScriptTag({ content: jsqrSrc })
  const decoded = await t.page.evaluate(async () => {
    const img = document.querySelector('img.bqr'); const cv = document.createElement('canvas'); cv.width = cv.height = 280
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 280, 280); g.drawImage(img, 24, 24, 232, 232)
    const d = g.getImageData(0, 0, 280, 280); return window.jsQR(d.data, d.width, d.height)?.data ?? null
  })
  check('the branded QR on screen decodes to the ticket code', decoded === CODE, String(decoded))
  check('add to calendar, invite, my tickets and receipt are one tap away', await t.page.locator('.paid-act').count() === 4)
  check('no page errors (success)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}
{
  const t = await open(`/app/orders/${ORDER}`, { orderStatus: 'pending' })
  await t.page.waitForSelector('.pay-hero.wait', { timeout: 15000 }); await shot(t.page, '25-confirming')
  check('pending payment shows the confirming steps', /Confirming your payment/.test(await t.page.locator('.pay-hero').innerText()))
  await t.ctx.close()
}

// 4. My tickets: branded passes; used tickets are dimmed with no QR.
{
  const t = await open('/app/tickets', {})
  await t.page.waitForSelector('.pass', { timeout: 15000 })
  await t.page.getByRole('button', { name: /Show entry QR/ }).first().click(); await t.page.waitForSelector('img.bqr'); await t.page.waitForTimeout(400); await shot(t.page, '26-my-tickets')
  check('valid ticket opens its branded QR; used ticket has none', await t.page.locator('img.bqr').count() === 1 && await t.page.locator('.pass.spent').count() === 1)
  check('no page errors (my tickets)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 5. Organiser: design a ticket tier with a live preview.
{
  const t = await open(`/app/plans/${EV}`, { manage: true, review: 'approved' })
  await t.page.waitForSelector('.tk', { timeout: 15000 })
  await t.page.getByRole('button', { name: /Design/ }).nth(1).click(); await t.page.waitForTimeout(300)
  await t.page.getByRole('radio', { name: 'VVIP' }).click()
  const dlg = t.page.getByRole('dialog'); await dlg.getByLabel('Add a perk').fill('Meet & greet'); await dlg.getByRole('button', { name: 'Add', exact: true }).click()
  await shot(t.page, '27-designer')
  check('live preview follows the chosen tier and perks', (await t.page.locator('[role="dialog"] .tk').getAttribute('data-tier')) === 'vvip' && /Meet & greet/.test(await t.page.locator('[role="dialog"] .tk').innerText()))
  await t.page.getByRole('button', { name: 'Save design' }).click(); await t.page.waitForTimeout(400)
  const patch = t.seen.patches?.find(x => x.path === '/rest/v1/ticket_types')
  check('saving sends tier, design and perks', patch && patch.body.tier === 'vvip' && patch.body.perks.includes('Meet & greet'), JSON.stringify(patch))
  check('no page errors (designer)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
