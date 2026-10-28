// VYBE Tickets operations (migration 44), in a real browser against a MOCKED backend: seat choice at checkout with a server hold,
// offline door mode (opt-in, provisional, queued, synced, conflicts shown), scan investigation (filters, paging, detail, two-person
// actions), the privacy & retention admin, and ticket-email status. The rules themselves are tested against PostgreSQL in
// tests/db/rls.test.ts and scripts/tickets-concurrency.sh.
// Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174). SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const axe = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')

const BASE = process.env.BASE_URL ?? 'http://localhost:4174', SHOTS = process.env.SHOTS
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', EV = 'cccccccc-0000-4000-8000-000000000001', GA = 'eeeeeeee-0000-4000-8000-000000000001', TT = 'dddddddd-0000-4000-8000-000000000001'
const TK = '99999999-0000-4000-8000-000000000001', ORDER = 'ffffffff-0000-4000-8000-000000000001'
const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const event = { id: EV, host: ME, title: 'UJ Gala', description: 'Seated evening.', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Hall', visibility: 'public', capacity: 500, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', format: 'in_person', organization_id: null, city: 'Johannesburg', venue: 'Great Hall', sales_review: 'approved', sales_review_note: '', doors_open_at: null, entry_closes_at: null, admission_mode: 'offline_provisional', offline_authorized_until: later, offline_plan_note: 'Two supervisors, gate 1, conflicts reviewed after', profiles: { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null } }
const seats = ['001', '002', '003', '004'].map((n, i) => ({ id: `5eat0000-0000-4000-8000-00000000000${i}`, section: 'A', block: '', row: 'B', seat: n, zone: null, accessible: i === 3, restricted_view: false, state: i === 2 ? 'sold' : 'available' }))
// The offline manifest a supervisor loads: one ticket, with the per-ticket key the live QR is signed with.
const K = createHash('sha256').update('k-for-test').digest('hex')
const win = () => Math.floor(Date.now() / 30000)
const qr = () => `VYBE3:${TK}:0:${win()}:${createHash('sha256').update(`${K}:${win()}`).digest('hex').slice(0, 20)}`
const manifest = { id: 'mf000000-0000-4000-8000-000000000001', event: { id: EV, title: 'UJ Gala', timezone: 'Africa/Johannesburg' }, gate: 'Gate A', mode: 'offline_provisional', issued_at: now,
  valid_until: later, server_epoch: Math.floor(Date.now() / 1000), step_seconds: 30, tickets: [{ t: TK, v: 0, k: K, c: createHash('sha256').update('ABCDEFGHIJKLMNOPQRST').digest('hex'), r: 'VT-7KQM-2XPA', n: 'General', z: [], s: 'General Admission — No reserved seat', u: false, p: 'single', o: Math.floor(Date.now() / 1000) - 3600, x: Math.floor(Date.now() / 1000) + 7200, ss: false, g: true }] }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) }
const a11y = async (page, sel) => page.evaluate(async ([src, s]) => { eval(src); const r = await axe.run(s, { runOnly: ['wcag2a', 'wcag2aa'] }); return r.violations.map(v => `${v.id}:${v.nodes.map(n => n.target.join(' ')).join(',')}`) }, [axe, sel])

async function open(url, w = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const seen = { rpc: [], offline: false }
  await ctx.addInitScript(s => { try { sessionStorage.setItem('vybe:splash:v1', '1'); localStorage.setItem('sb-mock-auth-token', s) } catch {} }, JSON.stringify(session))
  await ctx.route('https://mock.supabase.test/**', route => {
    const r = route.request(), u = new URL(r.url()), h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h })
    const json = (b, status = 200) => route.fulfill({ status, headers: h, contentType: 'application/json', body: JSON.stringify(b) })
    const obj = (r.headers().accept ?? '').includes('vnd.pgrst.object')
    const body = () => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
    const p = u.pathname
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length), a = body(); seen.rpc.push({ fn, args: a })
      if (fn === 'admission_scan' && seen.offline) return route.abort('internetdisconnected')
      if (fn === 'offline_sync' && seen.offline) return route.abort('internetdisconnected')
      if (fn === 'my_profile') return json(me)
      if (fn === 'is_admin' || fn === 'is_staff') return json(Boolean(w.admin))
      if (fn === 'can_manage_event') return json(!w.buyer)
      if (fn === 'can_scan_event') return json(true)
      if (fn === 'ticket_units_taken') return json(0)
      if (fn === 'door_role') return json([{ role: 'supervisor', gate: null }])
      if (fn === 'start_scan_session') return json({ id: 'ssssssss-0000-4000-8000-000000000001', role: 'supervisor', server_time: now, event: { id: EV, title: 'UJ Gala', starts_at: later, timezone: 'Africa/Johannesburg', venue: 'Great Hall', status: 'active' }, gate: { id: GA, name: 'Gate A' }, session: null })
      if (fn === 'offline_manifest') return json(manifest)
      if (fn === 'offline_sync') return json({ results: a.p_items.map(x => ({ id: x.id, sync: 'conflict', case: 7, flags: [] })) })
      if (fn === 'seat_map') return json({ types: [{ id: TT, name: 'Stalls', price_cents: 25000, max_per_order: 4, zones: [] }], zones: [], seats, hold_minutes: 10, my_hold_expires_at: null })
      if (fn === 'hold_seats') return json({ expires_at: new Date(Date.now() + 600_000).toISOString(), seats: a.p_seats.map(id => `Section A · Row B · Seat ${seats.find(s => s.id === id).seat}`) })
      if (fn === 'release_my_seat_holds') return json(null)
      if (fn === 'buyer_fee_terms') return json({ buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 })
      if (fn === 'create_seated_order') return json({ id: ORDER, status: 'pending', total_cents: 50000, fee_cents: 0, subtotal_cents: 50000, expires_at: later, seats: ['Section A · Row B · Seat 001', 'Section A · Row B · Seat 002'] })
      if (fn === 'cancel_my_order') return json(null)
      if (fn === 'scan_search') { const off = a.p_offset ?? 0; return json({ total: 30, limit: 25, offset: off, rows: Array.from({ length: off ? 5 : 25 }, (_, i) => ({ id: 100 + off + i, at: now, device_time: i === 0 ? now : null, decision: i === 0 ? 'ACCEPTED' : 'ALREADY_USED', mode: i === 0 ? 'offline' : 'online', sync: i === 0 ? 'conflict' : null, gate: 'Gate A', scanner: 'Bob', device: 'Android · Chrome', ticket: TK, ref: 'VT-7KQM-2XPA', ticket_status: 'used', type: 'General', order: 'ffffffff', case: i === 0 ? 7 : null })) }) }
      if (fn === 'scan_detail') return json({ scan: { id: 100, at: now, device_time: now, decision: 'ACCEPTED', mode: 'offline', sync: 'conflict', gate: 'Gate A', scanner: 'Bob', device: 'Android · Chrome', reason: null, flags: [], device_seq: 4 },
        event: { id: EV, title: 'UJ Gala', starts_at: later, timezone: 'Africa/Johannesburg' },
        ticket: { id: TK, ref: 'VT-7KQM-2XPA', status: 'used', type: 'General', tier: 'general', entries: 1, inside: true, seat: null, transfers: 0, revoked_reason: null, order: 'ffffffff', order_status: 'paid', refund: null },
        history: [{ id: 99, at: now, device_time: null, decision: 'ACCEPTED', mode: 'online', sync: null, gate: 'Gate 3', scanner: 'Cara' }, { id: 100, at: now, device_time: now, decision: 'ACCEPTED', mode: 'offline', sync: 'conflict', gate: 'Gate A', scanner: 'Bob' }],
        admissions: [{ at: now, device_time: null, direction: 'in', mode: 'online', override: false, gate: 'Gate 3' }],
        cases: [{ id: 7, kind: 'offline_conflict', status: 'open', summary: '', resolution: '', created_at: now, events: [{ at: now, action: 'opened', detail: {}, actor: null }],
                  actions: [{ id: 3, kind: 'manual_admit', reason: 'Holder refused at gate 3 in error', status: 'pending', requested_by: 'Cara', mine: false }] }] })
      if (fn === 'case_decide_action' || fn === 'case_update') return json(null)
      if (fn === 'order_email_status') return json([{ status: 'sent', attempts: 1, at: now }])
      if (fn === 'resend_ticket_email') return json(null)
      if (fn === 'retention_apply') return json({ run: 9, dry_run: a.p_dry_run, counts: { scan_records: 42, seat_holds: 3 }, errors: [], policies: {} })
      return json(null)
    }
    if (p.startsWith('/functions/v1/pay-start')) return json({ action: 'https://sandbox.payfast.co.za/eng/process', method: 'POST', fields: { m_payment_id: ORDER } })
    if (p === '/rest/v1/events') { const e = w.buyer ? { ...event, host: 'bbbbbbbb-0000-4000-8000-000000000002', profiles: { ...event.profiles, id: 'bbbbbbbb-0000-4000-8000-000000000002', username: 'host' } } : event; return json(obj ? e : [e]) }
    if (p === '/rest/v1/ticket_types') return json([{ id: TT, event_id: EV, name: 'Stalls', description: '', kind: 'single', group_size: 1, price_cents: 25000, currency: 'ZAR', quantity_total: 100, max_per_order: 4, sales_start: null, sales_end: null, status: 'active', sort: 0, seating: 'reserved', seat_selection: 'buyer' }])
    if (p === '/rest/v1/event_gates') return json([{ id: GA, name: 'Gate A', status: 'open' }])
    if (p === '/rest/v1/orders') { const o = { id: ORDER, buyer: ME, event_id: EV, status: 'paid', provider: 'payfast', subtotal_cents: 50000, fee_cents: 0, total_cents: 50000, created_at: now, paid_at: now, events: event }; return json(obj ? o : [o]) }
    if (p === '/rest/v1/retention_policies') return json([{ category: 'scan_records', description: 'Door scan log', purpose: 'Admission control', basis: 'event_end', period: '1 year', action: 'delete', enforceable: true, approved: false, approval_reference: '', approved_at: null, version: 1 },
      { category: 'orders_and_tickets', description: 'Orders and tickets', purpose: 'Contract, tax', basis: 'created', period: null, action: 'keep', enforceable: false, approved: false, approval_reference: '', approved_at: null, version: 1 }])
    if (p === '/rest/v1/retention_runs' || p === '/rest/v1/legal_holds') return json([])
    if (p === '/rest/v1/profiles') return json(obj ? me : [me])
    return json(obj ? null : [])
  })
  const page = await ctx.newPage(); const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}

// 1. Seat choice at checkout.
{
  const t = await open(`/app/plans/${EV}`, { buyer: true })
  await t.page.waitForSelector('.tk-seats', { timeout: 15000 })
  await t.page.getByRole('button', { name: 'Choose seats' }).click()
  await t.page.waitForSelector('.sp-seat')
  check('sold seats cannot be chosen; accessible seats are marked', await t.page.getByRole('button', { name: /Seat 003, sold/ }).isDisabled() && await t.page.getByRole('button', { name: /Seat 004, accessible/ }).count() === 1)
  await t.page.getByRole('button', { name: /Row B, Seat 001$/ }).click(); await t.page.getByRole('button', { name: /Row B, Seat 002$/ }).click()
  check('the bar shows the seats and price before holding', /2 seats · R\s?500,00/.test(await t.page.locator('.sp-bar').innerText()))
  await shot(t.page, 'seat-plan')
  const ax = await a11y(t.page, '.sp'); check('seat plan: no WCAG A/AA violations', ax.length === 0, ax.join(' | '))
  await t.page.getByRole('button', { name: /Hold for 10 minutes/ }).click(); await t.page.waitForTimeout(300)
  const bar = await t.page.locator('.tix-bar').innerText()
  check('the hold is the server’s: a live countdown shows on the ticket bar', /Seats held · \d+:\d\d left/.test(bar), bar.replace(/\n/g, ' | '))
  check('hold_seats was sent the chosen seat ids', t.seen.rpc.some(x => x.fn === 'hold_seats' && x.args.p_seats.length === 2))
  await t.page.getByRole('button', { name: /Checkout/ }).click(); await t.page.waitForSelector('.co')
  check('checkout lists the held seats', /Section A · Row B · Seat 001 · Section A · Row B · Seat 002/.test(await t.page.locator('.co-tickets').innerText()))
  await t.page.route('https://sandbox.payfast.co.za/**', r => r.fulfill({ status: 200, body: 'ok' }))
  await t.page.getByRole('button', { name: /Pay R\s?500,00 securely/ }).click(); await t.page.waitForTimeout(800)
  check('checkout with chosen seats uses create_seated_order', t.seen.rpc.some(x => x.fn === 'create_seated_order' && x.args.p_items[0].qty === 2) && !t.seen.rpc.some(x => x.fn === 'create_order'))
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. Offline door mode: explicit opt-in, provisional answers, queued, then synced with a conflict shown.
{
  const t = await open(`/app/scan/${EV}`)
  await t.page.waitForSelector('#door-gate'); await t.page.selectOption('#door-gate', GA)
  await t.page.getByRole('button', { name: /Start scanner session/ }).click(); await t.page.waitForSelector('.door-offline-kit')
  await t.page.getByRole('button', { name: 'Load offline data' }).click(); await t.page.waitForTimeout(500)
  check('the supervisor sees how much offline data is on the phone', /Offline data: 1 tickets/.test(await t.page.locator('.door-offline-kit').innerText()))
  t.seen.offline = true
  await t.page.fill('#ds-code', qr()); await t.page.getByRole('button', { name: 'Check', exact: true }).click()
  await t.page.waitForSelector('.door-result', { timeout: 8000 }); await t.page.waitForTimeout(2500)
  check('with offline admission OFF, a dropped connection still means SYSTEM UNAVAILABLE (no silent downgrade)', /SYSTEM UNAVAILABLE — DO NOT ADMIT/.test(await t.page.locator('.door-result').innerText()))
  await t.page.getByLabel('Use offline admission when the connection drops').check()
  const answer = async (re) => t.page.waitForFunction(r => new RegExp(r).test(document.querySelector('.door-result')?.textContent ?? ''), re.source, { timeout: 15000 }).catch(() => null)
  await t.page.fill('#ds-code', qr()); await t.page.getByRole('button', { name: 'Check', exact: true }).click(); await answer(/PROVISIONAL/)
  let txt = await t.page.locator('.door-result').innerText()
  check('offline ON: a genuine QR is admitted PROVISIONALLY, and the screen says why that is weaker', /PROVISIONAL · ADMIT/.test(txt) && /Another phone may have admitted a copy/.test(txt), txt.replace(/\n/g, ' | '))
  await t.page.getByRole('button', { name: 'Next ticket' }).click()
  const t0 = Date.now()
  await t.page.fill('#ds-code', qr()); await t.page.getByRole('button', { name: 'Check', exact: true }).click(); await answer(/ALREADY USED/)
  check('once the phone knows it is offline, the next answer comes quickly (one server attempt, not three)', Date.now() - t0 < 4000, `${Date.now() - t0} ms`)
  check('the same ticket again on this phone: ALREADY USED', /ALREADY USED/.test(await t.page.locator('.door-result').innerText()))
  check('the badge and banner say OFFLINE (provisional) and SYNC PENDING', /OFFLINE \(provisional\)/.test(await t.page.locator('.door-net').innerText()) && /SYNC PENDING: 2 offline scans/.test(await t.page.locator('.door-ctx').innerText()))
  await shot(t.page, 'door-offline-provisional')
  t.seen.offline = false
  await t.page.getByRole('button', { name: 'Upload now' }).click(); await t.page.waitForTimeout(800)
  const ctxText = await t.page.locator('.door-ctx').innerText()
  check('after reconnecting the queue uploads; conflicts are shown, not hidden', /SYNC CONFLICT: 2 need a supervisor/.test(ctxText) && !/SYNC PENDING/.test(ctxText), ctxText.replace(/\n/g, ' | '))
  const sync = t.seen.rpc.find(x => x.fn === 'offline_sync' && x.args.p_items?.length === 2)
  check('each offline scan was uploaded once with its own id, sequence and manifest', !!sync && new Set(sync.args.p_items.map(x => x.id)).size === 2 && sync.args.p_items.map(x => x.seq).join() === '1,2' && sync.args.p_items.every(x => x.manifest === manifest.id))
  const ax = await a11y(t.page, '.door'); check('door screen (offline): no WCAG A/AA violations', ax.length === 0, ax.join(' | '))
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 3. Scan investigation.
{
  const t = await open(`/app/scans/${EV}`)
  await t.page.waitForSelector('.inv-table', { timeout: 15000 })
  check('results are paged on the server (30 found, 25 shown)', /30 scans/.test(await t.page.locator('.inv').innerText()) && await t.page.locator('.inv-table tbody tr').count() === 25)
  const calls = t.seen.rpc.filter(x => x.fn === 'scan_search').length; await t.page.waitForTimeout(1000)
  check('the page does not keep re-querying on its own', t.seen.rpc.filter(x => x.fn === 'scan_search').length === calls, `${calls} → ${t.seen.rpc.filter(x => x.fn === 'scan_search').length}`)
  await t.page.getByRole('button', { name: 'Next', exact: true }).click({ force: true }); await t.page.waitForTimeout(300)
  check('next page asks the server for offset 25', t.seen.rpc.some(x => x.fn === 'scan_search' && x.args.p_offset === 25))
  await t.page.selectOption('#if-mode', 'offline'); await t.page.getByLabel('Repeats and conflicts only').check(); await t.page.getByRole('button', { name: 'Search' }).click(); await t.page.waitForTimeout(300)
  check('filters go to the server', t.seen.rpc.some(x => x.fn === 'scan_search' && x.args.p_filters.mode === 'offline' && x.args.p_filters.conflicts === true))
  await t.page.getByRole('button', { name: 'Details' }).first().click(); await t.page.waitForSelector('.inv-detail')
  const d = await t.page.locator('.inv-detail').innerText()
  check('detail shows every scan of the ticket in order, with the offline caveat', /1\. ACCEPTED.*Gate 3/.test(d) && /2\. ACCEPTED.*Gate A.*offline/.test(d) && /which entry really came first may not be knowable/.test(d), d.slice(0, 300).replace(/\n/g, ' | '))
  check('a conflict is explained without accusing anyone', /The real order of entries may be uncertain/.test(d))
  await t.page.fill('#inv-note', 'Confirmed on CCTV: same person, gate 3 then gate A after a phone died')
  // force: Playwright's scroll-into-view inside the sheet trips its 'stable' check; the button's position was sampled as steady.
  await t.page.getByRole('button', { name: 'Approve' }).click({ force: true }); await t.page.waitForTimeout(300)
  check('a second person approves a pending action with a reason', t.seen.rpc.some(x => x.fn === 'case_decide_action' && x.args.p_approve === true && x.args.p_note.startsWith('Confirmed')))
  await shot(t.page, 'investigation')
  const ax = await a11y(t.page, '.inv-detail'); check('investigation detail: no WCAG A/AA violations', ax.length === 0, ax.join(' | '))
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 4. Admin → Privacy & retention.
{
  const t = await open('/admin/privacy', { admin: true })
  await t.page.waitForSelector('.priv', { timeout: 15000 })
  const p = await t.page.locator('.priv').innerText()
  check('the screen says these are proposals, not legal advice or compliance', /Proposed periods for review — not legal advice and not, by themselves, POPIA compliance/.test(p))
  check('every category shows purpose, clock, period and action; unscheduled ones say they need a legal schedule', /Admission control/.test(p) && /event ends/.test(p) && /needs a legal schedule/.test(p))
  await t.page.getByRole('button', { name: /Dry run/ }).click(); await t.page.waitForTimeout(300)
  check('dry run counts only (p_dry_run = true) and shows the count per category', t.seen.rpc.some(x => x.fn === 'retention_apply' && x.args.p_dry_run === true) && /42/.test(await t.page.locator('.priv table').innerText()))
  await t.page.getByRole('button', { name: 'Change' }).first().click()
  check('approving needs an approval reference', await t.page.locator('.priv table').getByRole('button', { name: 'Approve' }).first().isDisabled())
  await shot(t.page, 'privacy')
  const ax = await a11y(t.page, '.priv'); check('privacy admin: no WCAG A/AA violations', ax.length === 0, ax.join(' | '))
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 5. Order page: email status and resend.
{
  const t = await open(`/app/orders/${ORDER}`)
  await t.page.waitForSelector('.order-mail', { timeout: 15000 })
  check('the order says the email was handed to the provider (not "delivered")', /handed to our email provider/.test(await t.page.locator('.order-mail').innerText()))
  await t.page.getByRole('button', { name: 'Send the email again' }).click(); await t.page.waitForTimeout(300)
  check('resend calls the server (which never issues new tickets)', t.seen.rpc.some(x => x.fn === 'resend_ticket_email' && x.args.p_order === ORDER))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
