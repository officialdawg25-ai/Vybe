// Event admission (migration 43): the door screen (gate session, ADMIT / DENY / HOLD, fail-closed offline), the organiser's
// "Entry, gates & seating" panel, and the ticket facts in My tickets. MOCKED backend: the decisions themselves are tested
// against a real database in tests/db/rls.test.ts and scripts/tickets-concurrency.sh.
// Build with VITE_SUPABASE_URL=https://mock.supabase.test, serve on BASE_URL (default http://localhost:4174). SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
const axe = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')

const BASE = process.env.BASE_URL ?? 'http://localhost:4174', SHOTS = process.env.SHOTS
const ME = 'aaaaaaaa-0000-4000-8000-000000000001', EV = 'cccccccc-0000-4000-8000-000000000001', GA = 'eeeeeeee-0000-4000-8000-000000000001', VV = 'eeeeeeee-0000-4000-8000-000000000002'
const TK = '99999999-0000-4000-8000-000000000001', TT = 'dddddddd-0000-4000-8000-000000000001'
const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'none' })}.${b64({ sub: ME, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
const session = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: ME, aud: 'authenticated', email: 'alice@example.com', app_metadata: {}, user_metadata: {} } }
const me = { id: ME, username: 'alice', display_name: 'Alice', bio: '', avatar_path: null, cover_path: null, interests: [], onboarded_at: now, verified_until: null, show_followers: 'public', follow_policy: 'everyone', dm_policy: 'everyone' }
const event = { id: EV, host: ME, title: 'UJ Student Concert', description: 'Live on campus.', cover_path: null, starts_at: later, ends_at: null, timezone: 'Africa/Johannesburg', location: 'Main Hall', visibility: 'public', capacity: 500, community_id: null, price_cents: null, currency: null, ticket_url: null, status: 'active', format: 'in_person', organization_id: null, city: 'Johannesburg', venue: 'Main Hall', sales_review: 'approved', sales_review_note: '', doors_open_at: null, entry_closes_at: null, profiles: { id: ME, username: 'alice', display_name: 'Alice', avatar_path: null } }
const ticketResp = (decision, extra = {}) => ({ decision, admit: decision === 'ACCEPTED', message: decision, event: 'UJ Student Concert', gate: 'Gate A', ...extra })
const tk = { id: TK, ref: 'VT-7KQM-2XPA', type: 'VIP', tier: 'vip', zones: ['VIP Deck'], seat: 'Section A · Row B · Seat 014', entry_policy: 'single', entries: 1 }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
let failures = 0
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`) }
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) }

async function open(url, w = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
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
      const fn = p.slice('/rest/v1/rpc/'.length), a = body(); seen.rpc.push({ fn, args: a })
      if (fn === 'my_profile') return json(me)
      if (fn === 'is_admin' || fn === 'is_staff') return json(false)
      if (fn === 'can_manage_event' || fn === 'can_scan_event') return json(true)
      if (fn === 'door_role') return json([{ role: w.role ?? 'supervisor', gate: null }])
      if (fn === 'start_scan_session') return json({ id: 'ssssssss-0000-4000-8000-000000000001', role: w.role ?? 'supervisor', server_time: now, event: { id: EV, title: 'UJ Student Concert', starts_at: later, timezone: 'Africa/Johannesburg', venue: 'Main Hall', status: 'active' }, gate: a.p_gate ? { id: a.p_gate, name: a.p_gate === GA ? 'Gate A' : 'VVIP Entrance' } : null, session: null })
      if (fn === 'admission_scan') {
        const c = a.p_credential
        if (c === 'DOWN') return route.abort('internetdisconnected')
        if (c === 'GOOD') return json(ticketResp('ACCEPTED', { ticket: tk, holder: 'Thandi' }))
        if (c === 'WRONG') return json(ticketResp('WRONG_EVENT', { valid_for: 'TUT Campus Festival', scanned_at: 'UJ Student Concert' }))
        if (c === 'USED') return json(ticketResp('ALREADY_USED', { used_at: now, used_gate: 'Gate A', ticket: tk }))
        if (c === 'GATE') return json(ticketResp('WRONG_GATE_OR_ZONE', { ticket: { ...tk, type: 'General', zones: [], seat: 'General Admission — No reserved seat' } }))
        if (c === 'HOLD') return json(ticketResp('MANUAL_REVIEW', { reason: 'reserved seat not assigned', ticket: { ...tk, seat: 'Reserved seat not assigned yet' } }))
        return json(ticketResp('INVALID'))
      }
      if (fn === 'admission_override') return json(ticketResp('ACCEPTED', { override: true, ticket: tk }))
      if (fn === 'end_scan_session') return json(null)
      if (fn === 'admission_dashboard') return json({ capacity: 500, issued: 312, admitted: 120, inside_now: 118, unseated: 1, by_decision: { ACCEPTED: 120, ALREADY_USED: 4, WRONG_EVENT: 2 }, by_gate: [{ gate: 'Gate A', admitted: 100, denied: 5 }, { gate: 'VVIP Entrance', admitted: 20, denied: 1 }], by_type: [], active_scanners: [{ id: 's1', scanner: 'Bob', gate: 'Gate A', device: 'Android · Chrome', last_seen_at: now }], repeat_denials: [] })
      if (fn === 'my_ticket_details') return json({ ref: 'VT-7KQM-2XPA', status: 'valid', event_status: 'active', entries: 0, entry_policy: 'single', max_entries: null, seat: 'Section A · Row B · Seat 014', zones: ['VIP Deck'], gates: ['Gate A'], sessions: [], entry_opens_at: now, entry_closes_at: later, timezone: 'Africa/Johannesburg' })
      if (fn === 'my_ticket_qr') return json({ tokens: [{ w: Math.floor(Date.now() / 30000), token: `VYBE3:${TK}:0:${Math.floor(Date.now() / 30000)}:0123456789abcdef0123` }], step_seconds: 30, static_ok: true, server_epoch: Math.floor(Date.now() / 1000) })
      if (fn === 'my_ticket_conflicts') return json(w.conflicts ?? [])
      if (fn === 'event_fee_terms') return json(null)
      return json(null)
    }
    if (p === '/rest/v1/events') return json(obj ? event : [event])
    if (p === '/rest/v1/event_gates') return json([{ id: GA, name: 'Gate A', status: 'open', admits_unzoned: true }, { id: VV, name: 'VVIP Entrance', status: 'open', admits_unzoned: false }])
    if (p === '/rest/v1/event_zones') return json([{ id: 'z1', name: 'VIP Deck', kind: 'vip', capacity: null }])
    if (p === '/rest/v1/gate_zones') return json([{ gate_id: VV, zone_id: 'z1' }])
    if (p === '/rest/v1/ticket_types') return json([{ id: TT, event_id: EV, name: 'VIP', entry_policy: 'single', max_entries: null, seating: 'reserved', entry_opens_at: null, entry_closes_at: null, sort: 0, price_cents: 0, quantity_total: 50, status: 'active' }])
    if (p === '/rest/v1/event_staff') return json([{ user_id: 'x', role: 'scanner', gate_id: GA, expires_at: null, profiles: { username: 'doorbob', display_name: 'Bob' } }])
    if (p === '/rest/v1/tickets') return json([{ id: TK, status: 'valid', transfers: 0, event_id: EV, events: { id: EV, title: 'UJ Student Concert', starts_at: later, timezone: 'Africa/Johannesburg', venue: 'Main Hall', city: 'Johannesburg' }, ticket_types: { name: 'VIP', tier: 'vip', perks: [] } }])
    if (p === '/rest/v1/profiles') return json(obj ? me : [me])
    return json(obj ? null : [])
  })
  const page = await ctx.newPage(); const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(BASE + url)
  return { ctx, page, seen, errors }
}
const type = async (page, code) => { await page.fill('#ds-code', code); await page.getByRole('button', { name: 'Check', exact: true }).click(); await page.waitForTimeout(250) }
const resultText = page => page.locator('.door-result').innerText()

// 1. The door: pick a gate, scan, read the answer.
{
  const t = await open(`/app/scan/${EV}`)
  await t.page.waitForSelector('#door-gate', { timeout: 10000 })
  check('the scanner asks for the gate before it starts', await t.page.getByRole('button', { name: /Start scanner session/ }).isDisabled())
  await t.page.selectOption('#door-gate', GA)
  await t.page.getByRole('button', { name: /Start scanner session/ }).click()
  await t.page.waitForSelector('.door-ctx')
  const ctxText = await t.page.locator('.door-ctx').innerText()
  check('the active event, venue and gate are shown at all times', /UJ Student Concert/.test(ctxText) && /Main Hall/.test(ctxText) && /Gate A/.test(ctxText), ctxText.replace(/\n/g, ' | '))
  check('start_scan_session was called with the chosen gate and this device', t.seen.rpc.some(x => x.fn === 'start_scan_session' && x.args.p_gate === GA && x.args.p_device.includes('·')))

  await type(t.page, 'GOOD')
  let txt = await resultText(t.page)
  check('ACCEPTED shows ADMIT, "Let them in", the category, zone and full seat', /ADMIT/.test(txt) && /Let them in/.test(txt) && /VIP · VIP Deck/.test(txt) && /Section A · Row B · Seat 014/.test(txt), txt.replace(/\n/g, ' | '))
  check('…with a tone class and an icon, not colour alone', await t.page.locator('.door-result.tone-admit svg').count() === 1)
  await shot(t.page, 'door-admit')
  const a = await t.page.evaluate(async src => { eval(src); const r = await axe.run('.door', { runOnly: ['wcag2a', 'wcag2aa'] }); return r.violations.map(v => `${v.id}:${v.nodes.map(n => n.target.join(' ') + ' ' + (n.any[0]?.message ?? '')).join(' / ')}`) }, axe)
  check('door screen: no WCAG A/AA violations', a.length === 0, a.join(', '))

  await type(t.page, 'WRONG')
  txt = await resultText(t.page)
  check('WRONG EVENT names both events and says do not admit', /WRONG EVENT/.test(txt) && /valid for TUT Campus Festival, not UJ Student Concert/.test(txt) && /Do not admit/.test(txt) && !/Let them in/.test(txt))
  await type(t.page, 'USED')
  check('ALREADY USED shows the first gate', /ALREADY USED/.test(await resultText(t.page)) && /at Gate A/.test(await resultText(t.page)))
  await type(t.page, 'GATE')
  check('WRONG GATE says where to send them and shows "General Admission — No reserved seat"', /WRONG GATE/.test(await resultText(t.page)) && /General Admission — No reserved seat/.test(await resultText(t.page)))

  await type(t.page, 'HOLD')
  txt = await resultText(t.page)
  check('MANUAL REVIEW holds (not admitted) and offers the supervisor action', /HOLD — SUPERVISOR/.test(txt) && /Do not admit yet/.test(txt) && await t.page.getByRole('button', { name: /Admit after checking/ }).count() === 1)
  t.page.once('dialog', d => d.accept('Checked student card and seat plan'))
  await t.page.getByRole('button', { name: /Admit after checking/ }).click(); await t.page.waitForTimeout(300)
  check('the override sends the reason and shows that it was a supervisor override', t.seen.rpc.some(x => x.fn === 'admission_override' && x.args.p_reason === 'Checked student card and seat plan') && /supervisor override/.test(await resultText(t.page)))

  // Offline: the request never reaches the server → NOT VERIFIED, retried with the same request id, never ADMIT.
  await t.page.fill('#ds-code', 'DOWN'); await t.page.getByRole('button', { name: 'Check', exact: true }).click()
  await t.page.waitForSelector('.door-result.tone-deny', { timeout: 8000 }); await t.page.waitForTimeout(2500)
  txt = await resultText(t.page)
  const downs = t.seen.rpc.filter(x => x.fn === 'admission_scan' && x.args.p_credential === 'DOWN')
  check('no connection → NOT VERIFIED — DO NOT ADMIT (never ADMIT)', /NOT VERIFIED — DO NOT ADMIT/.test(txt) && !/Let them in/.test(txt), txt.replace(/\n/g, ' | '))
  check('…retried with one and the same request id (no double counting)', downs.length >= 2 && new Set(downs.map(x => x.args.p_request)).size === 1, `${downs.length} tries`)
  check('…and the screen says the phone is offline', /Offline/.test(await t.page.locator('.door-net').innerText()))
  await shot(t.page, 'door-offline')
  check('session history lists the scans', await t.page.locator('.door .list .scan').count() >= 6)
  check('no horizontal scroll at phone width', await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 2. A plain scanner (not a supervisor): no reference lookups, no override button.
{
  const t = await open(`/app/scan/${EV}`, { role: 'scanner' })
  await t.page.waitForSelector('#door-gate'); await t.page.selectOption('#door-gate', GA)
  await t.page.getByRole('button', { name: /Start scanner session/ }).click(); await t.page.waitForSelector('.door-ctx')
  check('scanners are told it is a code field (no reference lookup)', (await t.page.locator('label[for="ds-code"]').innerText()).trim() === 'Ticket code')
  await type(t.page, 'HOLD')
  check('a scanner sees HOLD without an override button', await t.page.getByRole('button', { name: /Admit after checking/ }).count() === 0)
  await t.ctx.close()
}

// 3. Organiser: live numbers and the setup panel.
{
  const t = await open(`/app/plans/${EV}`)
  await t.page.waitForSelector('.door-setup', { timeout: 10000 })
  const live = await t.page.locator('.ds-live').innerText()
  check('live numbers from records: admitted, issued, inside / capacity', /120\s*admitted/.test(live) && /312\s*tickets issued/.test(live) && /118\s*inside now \/ 500/.test(live), live.replace(/\n/g, ' | '))
  check('unseated reserved tickets are flagged', /1 reserved-seat ticket has no seat yet/.test(live))
  check('active scanner sessions can be stopped', await t.page.locator('.ds-live').getByRole('button', { name: 'Stop' }).count() === 1)
  await t.page.getByRole('button', { name: /Set up entry rules/ }).click()
  await t.page.waitForSelector('.ds-body')
  const body = await t.page.locator('.ds-body').innerText()
  check('setup shows entry times, zones, gates, ticket rules, seats and the door team', ['Entry times', 'Zones', 'Gates', 'What each ticket admits to', 'Seats', 'Door team'].every(s => body.includes(s)))
  check('a reserved-seat type with no seat plan is called out', /reserved seats but there is no seat plan/.test(body))
  check('the VVIP entrance shows General admission unticked', !(await t.page.locator('.ds-gate').nth(1).locator('input[type=checkbox]').first().isChecked()))
  await shot(t.page, 'organiser-door-setup')
  const a = await t.page.evaluate(async src => { eval(src); const r = await axe.run('.door-setup', { runOnly: ['wcag2a', 'wcag2aa'] }); return r.violations.map(v => `${v.id}:${v.nodes.length}`) }, axe)
  check('organiser panel: no WCAG A/AA violations', a.length === 0, a.join(', '))
  check('no horizontal scroll at phone width', await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 4. The wallet: what the ticket grants, from the server.
{
  const t = await open('/app/tickets')
  await t.page.waitForSelector('.pass-facts', { timeout: 10000 })
  const f = await t.page.locator('.pass-facts').innerText()
  check('ticket shows its reference, full seat, access zone and entrance', /VT-7KQM-2XPA/.test(f) && /Section A · Row B · Seat 014/.test(f) && /VIP Deck/.test(f) && /Gate A/.test(f), f.replace(/\n/g, ' | '))
  await t.page.getByRole('button', { name: /Show entry QR/ }).click(); await t.page.waitForTimeout(500)
  check('the QR is drawn from the versioned token', await t.page.locator('.pass-qr-frame svg, .pass-qr-frame canvas, .pass-qr-frame img').count() >= 1)
  check('holders can get a new QR (old copies stop working)', await t.page.getByRole('button', { name: /Get a new QR/ }).count() === 1)
  await shot(t.page, 'wallet')
  check('no page errors', t.errors.length === 0, t.errors.join(' | '))
  await t.ctx.close()
}

// 5. Scheduling help on an event page.
{
  const t = await open(`/app/plans/${EV}`, { conflicts: [{ id: 'cccccccc-0000-4000-8000-000000000002', title: 'TUT Campus Festival', starts_at: later }] })
  await t.page.waitForSelector('.door-setup', { timeout: 10000 })
  check('overlapping tickets are mentioned as help, and both stay valid', /another ticketed event at the same time: TUT Campus Festival\. Both tickets stay valid\./.test(await t.page.locator('body').innerText()))
  await t.ctx.close()
}

await browser.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
