// Browser checks for VYBE Tickets screens (migration 28), against a MOCKED backend: the organiser's "Ticket sales & door"
// panel, a buyer seeing paid tickets wait for review, the door scanner's answers, and Admin → Tickets & Trust (review,
// terms + calculator, money + reconciliation). Behaviour and exact calls only; the database rules are tested in tests/db
// and scripts/tickets-concurrency.sh. Build with VITE_SUPABASE_URL=https://mock.supabase.test; SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4174'
const SHOTS = process.env.SHOTS
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', EV = 'cccccccc-0000-4000-8000-000000000001', TT = 'dddddddd-0000-4000-8000-000000000001', FREE = 'dddddddd-0000-4000-8000-000000000002'
const now = new Date().toISOString(), later = new Date(Date.now() + 9 * 86400_000).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const event = review => ({ id: EV, host: review.host ?? ME, title: 'Graduation party', description: 'Caps in the air.', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Rooftop', visibility: 'public', capacity: null, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', format: 'in_person', organization_id: null, city: 'Johannesburg', venue: 'The Rooftop', sales_review: review.status, sales_review_note: review.note ?? '', profiles: { id: review.host ?? ME, username: 'alice', display_name: 'Alice', avatar_path: null } })
const types = [{ id: TT, event_id: EV, name: 'General', description: '', kind: 'single', group_size: 1, price_cents: 15000, currency: 'ZAR', quantity_total: 100, max_per_order: 4, sales_start: null, sales_end: null, status: 'active', sort: 0 },
  { id: FREE, event_id: EV, name: 'Guest list', description: '', kind: 'single', group_size: 1, price_cents: 0, currency: 'ZAR', quantity_total: 50, max_per_order: 2, sales_start: null, sales_end: null, status: 'active', sort: 1 }]

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) }

async function open(url, w = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
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
      return json(null)
    }
    if (p === '/rest/v1/events') {
      if (u.searchParams.get('sales_review')) return json([{ ...event({ status: 'submitted' }), host: 'bbbbbbbb-0000-4000-8000-000000000002', profiles: { username: 'nightco', display_name: 'Night Co' }, organizations: null }])
      return json(obj ? event({ status: w.review ?? 'not_submitted', note: w.note, host: w.host }) : [event({ status: w.review ?? 'not_submitted', host: w.host })])
    }
    if (p === '/rest/v1/ticket_types') return u.searchParams.has('price_cents') ? route.fulfill({ status: 200, headers: { ...h, 'content-range': '0-0/1' }, body: '' }) : json(types)
    if (p === '/rest/v1/event_evidence') return json(w.evidence ?? [])
    if (p === '/rest/v1/event_sales_decisions') return json([{ id: 1, from_status: 'not_submitted', to_status: 'submitted', reason: '', created_at: now }])
    if (p === '/rest/v1/event_staff') return json([{ user_id: 'x', role: 'scanner', profiles: { username: 'doorbob', display_name: 'Bob' } }])
    if (p === '/rest/v1/event_lineup') return json([{ id: 'l1', name: 'DJ Fresh', role: 'Headliner', bio: '', image_path: null, sort: 0, status: 'confirmed', status_note: '' }, { id: 'l2', name: 'Surprise guest', role: 'Guest', bio: '', image_path: null, sort: 1, status: 'pending', status_note: '' }])
    if (p === '/rest/v1/fee_policies') return json([{ id: 'f1', scope: 'platform', organization_id: null, event_id: null, name: 'Platform v1 (launch terms)', commission_bps: 0, commission_fixed_cents: 0, commission_per_ticket_cents: 0, buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300, buyer_fee_per_ticket_cents: 0, effective_from: '2026-10-19T00:00:00Z', retired_at: null, note: 'Migrated', created_at: now }])
    if (p === '/rest/v1/reconciliation_exceptions') return json(u.searchParams.get('status') === 'eq.open' ? [{ id: 1, kind: 'paid_after_expiry_soldout', ref_key: 'o1', severity: 'high', order_id: 'eeeeeeee-0000-4000-8000-000000000001', refund_id: null, payout_id: null, detail: { total_cents: 16050 }, status: 'open', resolution: '', created_at: now }] : [])
    if (p === '/rest/v1/payment_notifications') return json([{ id: 1, provider: 'payfast', provider_txn_id: '1089250', reported_status: 'COMPLETE', order_ref: 'eeeeeeee-0000', amount_cents: 16050, outcome: 'fulfilled', times_seen: 2, last_seen_at: now }])
    if (p === '/rest/v1/profiles') return json(obj ? me : [me])
    if (p.startsWith('/rest/v1/tickets')) return json([{ status: 'used' }, { status: 'valid' }])
    if (p.startsWith('/functions/v1/')) return json({ ok: true })
    return json(obj ? null : [])
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}

// 1. Organiser: the panel explains the gate, shows terms, evidence form, door team and the scanner link.
{
  const t = await open(`/app/plans/${EV}`, { manage: true, review: 'not_submitted' })
  await t.page.waitForSelector('#trust-h', { timeout: 15000 }); await t.page.waitForTimeout(500); await shot(t.page, '01-organiser-panel')
  const text = await t.page.locator('.trust').innerText()
  check('organiser sees the review state and why paid sales wait', /Not submitted/.test(text) && /Paid tickets go on sale once VYBE has checked/.test(text), text.slice(0, 200))
  check('organiser sees the commercial terms in plain words', /No commission is taken from your ticket sales; buyers pay a service fee of 5 % \+ R\s?3,00 per order/.test(text.replace(/ /g, ' ')), text.match(/Terms:[^\n]*/)?.[0])
  check('door team is listed and the scanner is one tap away', /Bob/.test(text) && await t.page.getByRole('link', { name: /Open the door scanner/ }).isVisible())
  check('submit is disabled until evidence exists', await t.page.getByRole('button', { name: 'Submit for review' }).isDisabled())
  check('lineup shows what VYBE established', (await t.page.locator('.act-status').allInnerTexts()).join('|') === 'Confirmed|Not yet verified')
  check('no page errors (organiser)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. Buyer: paid tickets explain the wait; free tickets can still be taken.
{
  const t = await open(`/app/plans/${EV}`, { manage: false, review: 'submitted', host: 'bbbbbbbb-0000-4000-8000-000000000002' })
  await t.page.waitForSelector('.tix-item', { timeout: 15000 }); await shot(t.page, '02-buyer-waiting')
  const rows = await t.page.locator('.tix-item').allInnerTexts()
  check('paid tickets say they open after review, with no quantity buttons', /On sale once VYBE has reviewed this event/.test(rows[0]) && await t.page.getByRole('button', { name: 'More General' }).count() === 0, rows[0])
  check('free tickets stay available', await t.page.getByRole('button', { name: 'More Guest list' }).count() === 1)
  check('no page errors (buyer)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 3. Door scanner: the server's answer is shown plainly; only the last characters of a code are kept on screen.
{
  const t = await open(`/app/scan/${EV}`)
  await t.page.waitForSelector('#ds-code', { timeout: 15000 })
  for (const c of ['ABCDE12345ABCDEFGOOD', 'ABCDE12345ABCDEFUSED', 'ZZZZZ']) { await t.page.fill('#ds-code', c); await t.page.getByRole('button', { name: 'Check in' }).click(); await t.page.waitForTimeout(300) }
  await shot(t.page, '03-door-scanner')
  const log = await t.page.locator('.scan').allInnerTexts()
  check('scanner shows welcome / already used / wrong event', /Welcome in/.test(log[2]) && /Already used/.test(log[1]) && /different event/.test(log[0]), log.join(' / '))
  check('scanner calls admit_ticket bound to the event', t.seen.rpc.filter(x => x.fn === 'admit_ticket').every(x => x.args.p_event === EV))
  check('full codes are not kept on screen', !log.join(' ').includes('ABCDE12345'))
  check('no page errors (scanner)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 4. Admin → Tickets & Trust.
{
  const t = await open('/admin/trust', { admin: true, review: 'submitted' })
  await t.page.waitForSelector('text=Graduation party', { timeout: 15000 }); await shot(t.page, '04-admin-queue')
  await t.page.getByText('Graduation party').click(); await t.page.waitForSelector('#rv-reason'); await shot(t.page, '05-admin-review')
  check('request-changes needs a reason', await t.page.getByRole('button', { name: 'Request changes' }).isDisabled())
  await t.page.getByRole('button', { name: 'Approve sales' }).click(); await t.page.waitForTimeout(300)
  check('approval goes through the review function', t.seen.rpc.some(x => x.fn === 'admin_review_event_sales' && x.args.p_decision === 'approved' && x.args.p_event === EV))
  await t.page.goto(BASE + '/admin/trust?tab=terms'); await t.page.waitForSelector('text=Scenario calculator'); await shot(t.page, '06-admin-terms')
  const calc = await t.page.locator('.calc').innerText()
  check('calculator shows a labelled estimate', /Net contribution \(estimate\)/.test(calc) && await t.page.getByText('Estimate', { exact: true }).isVisible())
  check('new terms need a reason before saving', await t.page.getByRole('button', { name: 'Save new terms' }).isDisabled())
  await t.page.goto(BASE + '/admin/trust?tab=money'); await t.page.waitForSelector('text=Reconciliation cases'); await shot(t.page, '07-admin-money')
  const money = await t.page.locator('main').innerText()
  check('money view states its accounting basis and that processing costs are not recorded', /provider-confirmed payments/.test(money) && /Not recorded/.test(money))
  check('open case and payment notification are listed', /paid after expiry soldout/.test(money) && /seen 2×/.test(money))
  await t.page.getByRole('button', { name: /Run checks now/ }).click(); await t.page.waitForTimeout(300)
  check('reconciliation runs on demand', t.seen.rpc.some(x => x.fn === 'finance_reconcile'))
  check('no page errors (admin)', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
