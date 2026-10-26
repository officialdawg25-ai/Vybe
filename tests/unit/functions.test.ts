import { describe, expect, it } from 'vitest'
import { handleOzowNotify, handlePayStart, handlePayfastItn } from '../../supabase/functions/_shared/handlers/pay.ts'
import { handleRefundProcess } from '../../supabase/functions/_shared/handlers/refunds.ts'
import { handleLiveControl, handleLiveToken, handleLiveWebhook } from '../../supabase/functions/_shared/handlers/live.ts'
import { handlePayoutAccount, validateBank } from '../../supabase/functions/_shared/handlers/payouts.ts'
import { decryptJson, encryptJson, newKeyB64 } from '../../supabase/functions/_shared/crypto.ts'
import { signToken, verifyJwt, verifyWebhook } from '../../supabase/functions/_shared/livekit.ts'
import { payfastApiSignature, payfastSignature, sha512Hex } from '../../supabase/functions/_shared/payments.ts'
import type { Deps, Env } from '../../supabase/functions/_shared/http.ts'

const OID = '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b', UID = 'aaaaaaaa-0000-4000-8000-000000000001', EID = 'eeeeeeee-0000-4000-8000-000000000005'
const SID = 'ssssssss-0000-4000-8000-000000000000'.replace(/s/g, '5'), RID = 'rrrrrrrr-0000-4000-8000-000000000000'.replace(/r/g, '6')
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const ENV: Env = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key', APP_ORIGIN: 'https://vybe.test',
  PAYFAST_MERCHANT_ID: '10000100', PAYFAST_MERCHANT_KEY: 'mk', PAYFAST_PASSPHRASE: 'pass', PAYFAST_SANDBOX: '1',
  OZOW_SITE_CODE: 'TST', OZOW_PRIVATE_KEY: 'priv', OZOW_IS_TEST: '1',
  LIVEKIT_URL: 'wss://demo.livekit.cloud', LIVEKIT_API_KEY: 'APIkey', LIVEKIT_API_SECRET: 'sekret-sekret-sekret-sekret-sekret!', PAYOUT_ENC_KEY: newKeyB64(),
}

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
interface World {
  order?: Record<string, unknown>; refund?: Record<string, unknown> | null; claim?: Record<string, unknown> | null; stream?: Record<string, unknown>[]
  users?: Record<string, { id: string; email: string }>; gate?: { ok: boolean; body: unknown; status?: number }; isAdmin?: boolean; canFinance?: boolean; orgRole?: string | null
  payfastValidate?: string; payfastRefund?: { status: number; body: unknown }; ozowApi?: { status: number; body: unknown } | null; ipCount?: number; account?: Record<string, unknown> | null
  event?: Record<string, unknown>; noteId?: number | null
}
/** A tiny fake of Supabase (Auth + PostgREST + RPC) and of the gateways, recording every call. */
function fake(w: World = {}) {
  const calls: Call[] = []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init.body === 'string' ? init.body : ''
    calls.push({ url, method: init.method ?? 'GET', headers, body })
    const ok = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...h } })
    if (url.endsWith('/auth/v1/user')) { const t = (headers.authorization ?? '').replace('Bearer ', ''); const u = w.users?.[t]; return u ? ok({ ...u, user_metadata: { username: 'alice' } }) : ok({ msg: 'bad jwt' }, 401) }
    if (url.includes('/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1]
      if (fn === 'call_token_gate') return w.gate?.ok ? ok(w.gate.body) : ok(w.gate?.body ?? { message: 'This call has ended' }, w.gate?.status ?? 400)
      if (fn === 'live_token_gate') return w.gate?.ok ? ok(w.gate.body) : ok(w.gate?.body ?? { message: 'This stream is not available' }, w.gate?.status ?? 400)
      if (fn === 'refund_claim') return ok(w.claim ?? null)
      if (fn === 'is_admin') return ok(Boolean(w.isAdmin))
      if (fn === 'can_view_finance') return ok(w.canFinance ?? true)
      if (fn === 'org_role') return ok(w.orgRole ?? null)
      if (fn === 'record_payment_notification') return w.noteId === undefined ? ok(null) : ok({ id: w.noteId, duplicate: false })
      return ok(null)
    }
    if (url.includes('/rest/v1/orders') && (init.method ?? 'GET') === 'GET') return url.includes('ip_hash=') ? ok([], 200, { 'content-range': `*/${w.ipCount ?? 0}` }) : ok(w.order ? [w.order] : [])
    if (url.includes('/rest/v1/orders') && init.method === 'PATCH') return ok([])
    if (url.includes('/rest/v1/events')) return ok([w.event ?? { title: 'Rooftop' }])
    if (url.includes('/rest/v1/refunds')) return ok(w.refund ? [w.refund] : [])
    if (url.includes('/rest/v1/live_streams')) return ok(w.stream ?? [])
    if (url.includes('/rest/v1/payout_accounts') && (init.method ?? 'GET') === 'GET') return ok(w.account ? [w.account] : [])
    if (url.includes('/rest/v1/')) return ok([])
    if (url.includes('/query/validate')) return new Response(w.payfastValidate ?? 'VALID')
    if (url.startsWith('https://api.payfast.co.za/refunds/')) return ok(w.payfastRefund?.body ?? {}, w.payfastRefund?.status ?? 200)
    if (url.startsWith('https://api.ozow.com/')) return w.ozowApi ? ok(w.ozowApi.body, w.ozowApi.status) : ok([], 404)
    if (url.includes('/twirp/livekit.RoomService/')) return ok({})
    return ok({}, 404)
  }) as typeof fetch
  return { calls, deps: { env: ENV, fetch: f } as Deps, rpcs: (name: string) => calls.filter(c => c.url.endsWith(`/rpc/${name}`)).map(c => JSON.parse(c.body || '{}')) }
}
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://fn/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const authed = (token = 'tok', body: unknown = {}, h: Record<string, string> = {}) => post(body, { authorization: `Bearer ${token}`, ...h })
const user = { tok: { id: UID, email: 'a@b.co' }, other: { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'o@b.co' } }
const order = (o: Record<string, unknown> = {}) => ({ id: OID, buyer: UID, event_id: EID, status: 'pending', provider: 'payfast', total_cents: 16050, expires_at: FUTURE, ...o })

describe('pay-start', () => {
  it('requires sign-in, and answers "not found" for other people’s orders', async () => {
    expect((await handlePayStart(post({ order_id: OID }), fake({ order: order() }).deps)).status).toBe(401)
    expect((await handlePayStart(authed('bad', { order_id: OID }), fake({ order: order(), users: user }).deps)).status).toBe(401)
    expect((await handlePayStart(authed('other', { order_id: OID }), fake({ order: order(), users: user }).deps)).status).toBe(404)
    expect((await handlePayStart(authed('tok', { order_id: 'nope' }), fake({ users: user }).deps)).status).toBe(404)
  })
  it('refuses orders that are not payable', async () => {
    expect((await handlePayStart(authed('tok', { order_id: OID }), fake({ order: order({ status: 'paid' }), users: user }).deps)).status).toBe(409)
    expect((await handlePayStart(authed('tok', { order_id: OID }), fake({ order: order({ expires_at: '2000-01-01T00:00:00Z' }), users: user }).deps)).status).toBe(410)
    expect((await handlePayStart(authed('tok', { order_id: OID }), fake({ order: order({ total_cents: 0, provider: 'free' }), users: user }).deps)).status).toBe(400)
  })
  it('returns a signed PayFast form that points back at our functions', async () => {
    const r = await handlePayStart(authed('tok', { order_id: OID }), fake({ order: order(), users: user }).deps)
    const c = await r.json() as { action: string; fields: Record<string, string> }
    expect(r.status).toBe(200); expect(c.action).toContain('sandbox.payfast.co.za'); expect(c.fields.notify_url).toBe('https://proj.supabase.co/functions/v1/payfast-itn')
    expect(c.fields.amount).toBe('160.50'); expect(c.fields.signature).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(c)).not.toContain('service-key'); expect(JSON.stringify(c)).not.toContain('pass"')
  })
  it('reports a missing provider configuration instead of failing silently', async () => {
    const f = fake({ order: order(), users: user }); f.deps.env = { ...ENV, PAYFAST_MERCHANT_ID: undefined }
    expect((await handlePayStart(authed('tok', { order_id: OID }), f.deps)).status).toBe(503)
  })
  it('signs an Ozow checkout for Ozow orders', async () => {
    const r = await handlePayStart(authed('tok', { order_id: OID }), fake({ order: order({ provider: 'ozow' }), users: user }).deps)
    const c = await r.json() as { action: string; fields: Record<string, string> }
    expect(c.action).toBe('https://pay.ozow.com'); expect(c.fields.NotifyUrl).toBe('https://proj.supabase.co/functions/v1/ozow-notify'); expect(c.fields.HashCheck).toMatch(/^[0-9a-f]{128}$/)
  })
  it('throttles many orders from one network', async () => {
    const r = await handlePayStart(authed('tok', { order_id: OID }, { 'x-forwarded-for': '203.0.113.9' }), fake({ order: order(), users: user, ipCount: 12 }).deps)
    expect(r.status).toBe(429)
    const ok = fake({ order: order(), users: user, ipCount: 3 }); expect((await handlePayStart(authed('tok', { order_id: OID }, { 'x-forwarded-for': '203.0.113.9' }), ok.deps)).status).toBe(200)
    expect(ok.calls.some(c => c.method === 'PATCH' && c.body.includes('ip_hash'))).toBe(true)
  })
})

function itnBody(over: Record<string, string> = {}, pass = ENV.PAYFAST_PASSPHRASE) {
  const fields: [string, string][] = Object.entries({ m_payment_id: OID, pf_payment_id: '1089250', payment_status: 'COMPLETE', amount_gross: '160.50', payment_method: 'cc', merchant_id: '10000100', ...over })
  fields.push(['signature', payfastSignature(fields, pass)])
  return new URLSearchParams(fields).toString()
}
const itnReq = (b: string) => new Request('https://fn/itn', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: b })

describe('payment notifications are recorded with what was done (migration 28)', () => {
  it('a settled payment is recorded, then marked fulfilled', async () => {
    const f = fake({ order: order(), noteId: 41 })
    await handlePayfastItn(itnReq(itnBody()), f.deps)
    expect(f.rpcs('record_payment_notification')).toEqual([{ p_provider: 'payfast', p_txn: '1089250', p_status: 'COMPLETE', p_order_ref: OID, p_amount_cents: 16050, p_currency: 'ZAR' }])
    expect(f.rpcs('finish_payment_notification')).toEqual([{ p_id: 41, p_outcome: 'fulfilled' }])
  })
  it('short payments, failed validation, unknown orders and database errors each leave the right outcome', async () => {
    const cases: [string, Parameters<typeof fake>[0], string][] = [
      [itnBody({ amount_gross: '1.00' }), { order: order(), noteId: 1 }, 'amount_mismatch'], [itnBody(), { order: order(), payfastValidate: 'INVALID', noteId: 1 }, 'not_confirmed'],
      [itnBody(), { noteId: 1 }, 'unknown_order'], [itnBody({ payment_status: 'FAILED' }), { order: order(), noteId: 1 }, 'closed'],
    ]
    for (const [b, w, outcome] of cases) { const f = fake(w); await handlePayfastItn(itnReq(b), f.deps); expect(f.rpcs('finish_payment_notification')).toEqual([{ p_id: 1, p_outcome: outcome }]) }
    const f = fake({ order: order(), noteId: 2 }); const orig = f.deps.fetch
    f.deps.fetch = (async (u: RequestInfo | URL, i?: RequestInit) => String(u).endsWith('/rpc/fulfill_order') ? new Response('{}', { status: 500 }) : orig(u, i)) as typeof fetch
    expect((await handlePayfastItn(itnReq(itnBody()), f.deps)).status).toBe(500)
    expect(f.rpcs('finish_payment_notification')).toEqual([{ p_id: 2, p_outcome: 'error' }])
  })
  it('a forged notification is never recorded (nothing is stored before the signature checks out)', async () => {
    const f = fake({ order: order(), noteId: 3 })
    await handlePayfastItn(itnReq(itnBody({}, 'wrong')), f.deps)
    expect(f.rpcs('record_payment_notification')).toHaveLength(0)
  })
  it('a server without migration 28 still settles payments', async () => {
    const f = fake({ order: order() })                                     // record_payment_notification answers nothing useful
    expect((await handlePayfastItn(itnReq(itnBody()), f.deps)).status).toBe(200)
    expect(f.rpcs('fulfill_order')).toHaveLength(1); expect(f.rpcs('finish_payment_notification')).toHaveLength(0)
  })
  it('pay-start refuses to take money for an event whose sales are paused or that was cancelled', async () => {
    for (const [event, msg] of [[{ title: 'X', status: 'active', sales_review: 'suspended' }, /paused/], [{ title: 'X', status: 'cancelled', sales_review: 'approved' }, /cancelled/]] as const) {
      const f = fake({ order: order(), users: { tok: { id: UID, email: 'a@b.c' } }, event })
      const r = await handlePayStart(new Request('https://fn/pay', { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ order_id: OID }) }), f.deps)
      expect(r.status).toBe(409); expect((await r.json()).error).toMatch(msg)
    }
    const ok = fake({ order: order(), users: { tok: { id: UID, email: 'a@b.c' } }, event: { title: 'X', status: 'active', sales_review: 'approved' } })
    expect((await handlePayStart(new Request('https://fn/pay', { method: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ order_id: OID }) }), ok.deps)).status).toBe(200)
  })
})

describe('payfast-itn', () => {
  it('records PayFast\'s own fee (amount_fee, sent negative) once the payment is settled, for ticket orders', async () => {
    const f = fake({ order: order() })
    await handlePayfastItn(itnReq(itnBody({ amount_fee: '-4.60', amount_net: '155.90' })), f.deps)
    expect(f.rpcs('record_processing_fee')).toEqual([{ p_order: OID, p_provider: 'payfast', p_txn: '1089250', p_fee_cents: 460 }])
    const unsettled = fake({ order: order(), payfastValidate: 'INVALID' })
    await handlePayfastItn(itnReq(itnBody({ amount_fee: '-4.60' })), unsettled.deps)
    expect(unsettled.rpcs('record_processing_fee')).toHaveLength(0)
    const noFee = fake({ order: order() })
    await handlePayfastItn(itnReq(itnBody({ amount_fee: '' })), noFee.deps)
    expect(noFee.rpcs('record_processing_fee')).toHaveLength(0)
  })
  it('settles a genuine, validated, correctly-priced payment exactly once per notification', async () => {
    const f = fake({ order: order() })
    expect((await handlePayfastItn(itnReq(itnBody()), f.deps)).status).toBe(200)
    expect(f.rpcs('fulfill_order')).toEqual([{ p_order: OID, p_provider: 'payfast', p_ref: '1089250', p_amount_cents: 16050, p_method: 'cc' }])
    expect(f.calls.some(c => c.url.includes('sandbox.payfast.co.za/eng/query/validate'))).toBe(true)
  })
  it('rejects: bad signature, wrong passphrase, wrong merchant, unknown order, wrong provider, short payment, failed validation', async () => {
    const cases: [string, Parameters<typeof fake>[0], number][] = [
      [itnBody({}, 'wrong'), { order: order() }, 400], [itnBody({ merchant_id: '999' }), { order: order() }, 400], [itnBody(), {}, 400],
      [itnBody(), { order: order({ provider: 'ozow' }) }, 400], [itnBody({ amount_gross: '1.00' }), { order: order() }, 400], [itnBody(), { order: order(), payfastValidate: 'INVALID' }, 400],
    ]
    for (const [b, w, status] of cases) { const f = fake(w); expect((await handlePayfastItn(itnReq(b), f.deps)).status).toBe(status); expect(f.rpcs('fulfill_order')).toHaveLength(0) }
  })
  it('a tampered body fails the signature check before anything else runs', async () => {
    const f = fake({ order: order() })
    expect((await handlePayfastItn(itnReq(itnBody().replace('160.50', '1.50')), f.deps)).status).toBe(400)
    expect(f.calls.filter(c => c.url.includes('/rest/v1/orders'))).toHaveLength(0)
  })
  it('closes cancelled and failed payments without issuing tickets', async () => {
    const f = fake({ order: order() })
    await handlePayfastItn(itnReq(itnBody({ payment_status: 'CANCELLED' })), f.deps)
    expect(f.rpcs('close_order')).toEqual([{ p_order: OID, p_status: 'cancelled' }]); expect(f.rpcs('fulfill_order')).toHaveLength(0)
  })
  it('asks PayFast to retry when the database step fails', async () => {
    const f = fake({ order: order() }); const orig = f.deps.fetch
    f.deps.fetch = (async (u: RequestInfo | URL, i?: RequestInit) => String(u).endsWith('/rpc/fulfill_order') ? new Response('{}', { status: 500 }) : orig(u, i)) as typeof fetch
    expect((await handlePayfastItn(itnReq(itnBody()), f.deps)).status).toBe(500)
  })
})

async function ozowBody(over: Record<string, string> = {}) {
  const base: Record<string, string> = { SiteCode: 'TST', TransactionId: 'tx-9', TransactionReference: OID, Amount: '160.50', Status: 'Complete', Optional1: '', Optional2: '', Optional3: '', Optional4: '', Optional5: '', CurrencyCode: 'ZAR', IsTest: 'true', StatusMessage: 'ok', ...over }
  const keys = ['SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status', 'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'CurrencyCode', 'IsTest', 'StatusMessage']
  return new URLSearchParams({ ...base, Hash: await sha512Hex((keys.map(k => base[k]).join('') + 'priv').toLowerCase()) }).toString()
}
describe('ozow-notify', () => {
  it('settles verified payments and records the method', async () => {
    const f = fake({ order: order({ provider: 'ozow' }) })
    expect((await handleOzowNotify(itnReq(await ozowBody()), f.deps)).status).toBe(200)
    expect(f.rpcs('fulfill_order')[0]).toMatchObject({ p_order: OID, p_provider: 'ozow', p_ref: 'tx-9', p_amount_cents: 16050, p_method: 'eft' })
  })
  it('rejects forged hashes, wrong amounts, test-mode mismatches', async () => {
    const o = order({ provider: 'ozow' })
    expect((await handleOzowNotify(itnReq((await ozowBody()).replace('Hash=', 'Hash=0')), fake({ order: o }).deps)).status).toBe(400)
    expect((await handleOzowNotify(itnReq(await ozowBody({ Amount: '1.00' })), fake({ order: o }).deps)).status).toBe(400)
    const live = fake({ order: o }); live.deps.env = { ...ENV, OZOW_IS_TEST: '0' }
    expect((await handleOzowNotify(itnReq(await ozowBody()), live.deps)).status).toBe(400)           // a TEST payment can never settle a LIVE order
    expect(live.rpcs('fulfill_order')).toHaveLength(0)
  })
  it('double-checks with Ozow’s API when an API key is configured', async () => {
    const o = order({ provider: 'ozow' }); const mk = (api: { status: number; body: unknown }) => { const f = fake({ order: o, ozowApi: api }); f.deps.env = { ...ENV, OZOW_API_KEY: 'k' }; return f }
    const good = mk({ status: 200, body: [{ status: 'Complete', amount: 160.5 }] }); expect((await handleOzowNotify(itnReq(await ozowBody()), good.deps)).status).toBe(200)
    const bad = mk({ status: 200, body: [{ status: 'Pending', amount: 160.5 }] }); expect((await handleOzowNotify(itnReq(await ozowBody()), bad.deps)).status).toBe(400); expect(bad.rpcs('fulfill_order')).toHaveLength(0)
  })
  it('closes cancelled payments', async () => {
    const f = fake({ order: order({ provider: 'ozow' }) }); await handleOzowNotify(itnReq(await ozowBody({ Status: 'Cancelled' })), f.deps)
    expect(f.rpcs('close_order')).toEqual([{ p_order: OID, p_status: 'cancelled' }])
  })
})

describe('refund-process', () => {
  const refund = (o = {}) => ({ id: RID, order_id: OID, requested_by: UID, status: 'approved', ticket_amount_cents: 15000, fee_amount_cents: 0, reason: 'plans changed', ...o })
  const base = (w: World = {}) => fake({ users: user, refund: refund(), claim: { ...refund(), status: 'processing' }, order: { id: OID, event_id: EID, provider: 'payfast', provider_ref: '1089250', payment_method: 'cc', status: 'paid' }, ...w })
  it('needs sign-in; unknown or invisible refunds are 404; only approved refunds move', async () => {
    expect((await handleRefundProcess(post({ refund_id: RID }), base().deps)).status).toBe(401)
    expect((await handleRefundProcess(authed('tok', { refund_id: RID }), base({ refund: null }).deps)).status).toBe(404)
    expect((await handleRefundProcess(authed('tok', { refund_id: RID }), base({ refund: refund({ status: 'requested' }) }).deps)).status).toBe(409)
    expect((await handleRefundProcess(authed('tok', { refund_id: 'x' }), base().deps)).status).toBe(400)
  })
  it('only one worker can claim a refund', async () => {
    const f = base({ claim: null }); expect((await handleRefundProcess(authed('tok', { refund_id: RID }), f.deps)).status).toBe(409)
    expect(f.calls.some(c => c.url.includes('api.payfast.co.za'))).toBe(false)
  })
  it('refunds PayFast card payments through the API with a valid signature, using the database amount', async () => {
    const f = base({ payfastRefund: { status: 200, body: { status: 'success' } } })
    const r = await handleRefundProcess(authed('tok', { refund_id: RID, amount: 99999999 }), f.deps)      // a client-supplied amount is ignored
    expect(await r.json()).toEqual({ status: 'succeeded' })
    const call = f.calls.find(c => c.url.startsWith('https://api.payfast.co.za/refunds/1089250'))!
    expect(call.url).toContain('testing=true'); expect(call.headers['merchant-id']).toBe('10000100'); expect(call.headers.version).toBe('v1')
    const sent = Object.fromEntries(new URLSearchParams(call.body)); expect(sent.amount).toBe('15000')
    expect(call.headers.signature).toBe(payfastApiSignature({ 'merchant-id': '10000100', version: 'v1', timestamp: call.headers.timestamp, ...sent }, 'pass'))
    expect(f.rpcs('refund_finish')[0]).toMatchObject({ p_status: 'succeeded', p_provider: 'payfast', p_ref: '1089250' })
  })
  it('never loses money in limbo: API errors, EFT payments and Ozow all become "manual_required"', async () => {
    const api = base({ payfastRefund: { status: 400, body: { status: 'failed', data: 'Refund not allowed' } } })
    expect((await (await handleRefundProcess(authed('tok', { refund_id: RID }), api.deps)).json() as { status: string }).status).toBe('manual_required')
    expect(api.rpcs('refund_finish')[0]).toMatchObject({ p_status: 'manual_required', p_error: 'Refund not allowed' })
    const eft = base({ order: { id: OID, event_id: EID, provider: 'payfast', provider_ref: '1', payment_method: 'eft', status: 'paid' } })
    expect((await (await handleRefundProcess(authed('tok', { refund_id: RID }), eft.deps)).json() as { status: string }).status).toBe('manual_required'); expect(eft.calls.some(c => c.url.includes('api.payfast.co.za'))).toBe(false)
    const oz = base({ order: { id: OID, event_id: EID, provider: 'ozow', provider_ref: 'tx', payment_method: 'eft', status: 'paid' } })
    expect((await (await handleRefundProcess(authed('tok', { refund_id: RID }), oz.deps)).json() as { status: string }).status).toBe('manual_required')
  })
  it('a network failure to the gateway also becomes manual, not a stuck "processing"', async () => {
    const f = base(); const orig = f.deps.fetch
    f.deps.fetch = (async (u: RequestInfo | URL, i?: RequestInit) => { if (String(u).includes('api.payfast.co.za')) throw new Error('down'); return orig(u, i) }) as typeof fetch
    expect((await (await handleRefundProcess(authed('tok', { refund_id: RID }), f.deps)).json() as { status: string }).status).toBe('manual_required')
  })
  it('zero-value refunds just complete', async () => {
    const f = base({ claim: { ...refund(), status: 'processing', ticket_amount_cents: 0 } }); expect((await (await handleRefundProcess(authed('tok', { refund_id: RID }), f.deps)).json() as { status: string }).status).toBe('succeeded')
  })
})

describe('livekit', () => {
  const gate = (role: 'host' | 'guest' | 'viewer') => ({ ok: true, body: { room: 'room-abc', role, name: 'Alice', title: 'Gig', status: 'live' } })
  it('mints a viewer token that can subscribe and chat but not publish', async () => {
    const f = fake({ users: user, gate: gate('viewer') })
    const r = await handleLiveToken(authed('tok', { stream_id: SID }), f.deps)
    const out = await r.json() as { token: string; url: string; role: string }
    expect(r.status).toBe(200); expect(out.url).toBe('wss://demo.livekit.cloud'); expect(out.role).toBe('viewer')
    const claims = await verifyJwt(out.token, ENV.LIVEKIT_API_SECRET!) as { iss: string; sub: string; video: Record<string, unknown>; exp: number }
    expect(claims).toMatchObject({ iss: 'APIkey', sub: UID, video: { room: 'room-abc', roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: true } })
    expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(2 * 3600_000 + 5000)
    expect(f.calls.some(c => c.url.includes('CreateRoom'))).toBe(false)
  })
  it('the host token can publish and the room is created with a viewer ceiling', async () => {
    const f = fake({ users: user, gate: gate('host') })
    const out = await (await handleLiveToken(authed('tok', { stream_id: SID, publish: true }), f.deps)).json() as { token: string }
    expect((await verifyJwt(out.token, ENV.LIVEKIT_API_SECRET!) as { video: { canPublish: boolean } }).video.canPublish).toBe(true)
    const create = f.calls.find(c => c.url.endsWith('/twirp/livekit.RoomService/CreateRoom'))!
    expect(JSON.parse(create.body)).toMatchObject({ name: 'room-abc', max_participants: 2001 })
    expect(create.url.startsWith('https://demo.livekit.cloud')).toBe(true)
    expect((await verifyJwt(create.headers.authorization.replace('Bearer ', ''), ENV.LIVEKIT_API_SECRET!) as { video: { roomAdmin: boolean } }).video.roomAdmin).toBe(true)
  })
  it('asks the database (as the user) and passes its refusal back without minting anything', async () => {
    const f = fake({ users: user, gate: { ok: false, status: 400, body: { message: 'You need a ticket for this event to watch' } } })
    const r = await handleLiveToken(authed('tok', { stream_id: SID }), f.deps)
    expect(r.status).toBe(403); expect((await r.json() as { error: string }).error).toBe('You need a ticket for this event to watch')
    const g = f.calls.find(c => c.url.endsWith('/rpc/live_token_gate'))!
    expect(g.headers.authorization).toBe('Bearer tok'); expect(g.headers.apikey).toBe('anon-key')           // user's JWT, never the service key
  })
  it('call tokens: both people can publish, the room holds two, and the database decides who may join', async () => {
    const CID = '7c7c7c7c-0000-4000-8000-000000000007'
    const f = fake({ users: user, gate: { ok: true, body: { room: 'call-xyz', kind: 'video', name: 'Alice', role: 'caller' } } })
    const out = await (await handleLiveToken(authed('tok', { call_id: CID }), f.deps)).json() as { token: string; kind: string }
    expect(out.kind).toBe('video')
    expect((await verifyJwt(out.token, ENV.LIVEKIT_API_SECRET!) as { video: Record<string, unknown> }).video).toMatchObject({ room: 'call-xyz', canPublish: true, canSubscribe: true })
    expect(JSON.parse(f.calls.find(c => c.url.endsWith('/CreateRoom'))!.body)).toMatchObject({ name: 'call-xyz', max_participants: 2 })
    const callee = fake({ users: user, gate: { ok: true, body: { room: 'call-xyz', kind: 'audio', name: 'Bob', role: 'callee' } } })
    expect((await handleLiveToken(authed('tok', { call_id: CID }), callee.deps)).status).toBe(200); expect(callee.calls.some(c => c.url.endsWith('/CreateRoom'))).toBe(false)
    const refused = fake({ users: user, gate: { ok: false, status: 400, body: { message: 'This call has ended' } } })
    expect((await handleLiveToken(authed('tok', { call_id: CID }), refused.deps)).status).toBe(403)
    expect((await handleLiveToken(authed('tok', { call_id: 'nope' }), fake({ users: user }).deps)).status).toBe(400)
  })
  it('requires sign-in, a stream id and configuration', async () => {
    expect((await handleLiveToken(post({ stream_id: SID }), fake({ users: user }).deps)).status).toBe(401)
    expect((await handleLiveToken(authed('tok', {}), fake({ users: user }).deps)).status).toBe(400)
    const f = fake({ users: user }); f.deps.env = { ...ENV, LIVEKIT_API_SECRET: undefined }; expect((await handleLiveToken(authed('tok', { stream_id: SID }), f.deps)).status).toBe(503)
  })
  it('host controls: end closes the room; ban removes the person; non-hosts get nothing', async () => {
    const f = fake({ users: user, stream: [{ room: 'room-abc' }] })
    expect((await handleLiveControl(authed('tok', { stream_id: SID, action: 'end' }), f.deps)).status).toBe(200)
    expect(f.rpcs('end_my_stream')).toEqual([{ sid: SID }]); expect(f.calls.some(c => c.url.endsWith('/DeleteRoom'))).toBe(true)
    const b = fake({ users: user, stream: [{ room: 'room-abc' }] })
    expect((await handleLiveControl(authed('tok', { stream_id: SID, action: 'ban', user_id: user.other.id }), b.deps)).status).toBe(200)
    expect(JSON.parse(b.calls.find(c => c.url.endsWith('/RemoveParticipant'))!.body)).toEqual({ room: 'room-abc', identity: user.other.id })
    const n = fake({ users: user, stream: [] }); expect((await handleLiveControl(authed('tok', { stream_id: SID, action: 'end' }), n.deps)).status).toBe(403); expect(n.rpcs('end_my_stream')).toHaveLength(0)
  })
  it('a guest on stage may publish camera and microphone only, and the room is not created by them', async () => {
    const f = fake({ users: user, gate: gate('guest') })
    const out = await (await handleLiveToken(authed('tok', { stream_id: SID }), f.deps)).json() as { token: string; role: string }
    const v = (await verifyJwt(out.token, ENV.LIVEKIT_API_SECRET!) as { video: Record<string, unknown> }).video
    expect(out.role).toBe('guest')
    expect(v).toMatchObject({ canPublish: true, canPublishSources: ['camera', 'microphone'], canSubscribe: true })
    expect(f.calls.some(c => c.url.includes('CreateRoom'))).toBe(false)
  })
  it('stage: the host adds and removes guests live (database first, then LiveKit permissions); others cannot', async () => {
    const f = fake({ users: user, stream: [{ room: 'room-abc' }] })
    expect((await handleLiveControl(authed('tok', { stream_id: SID, action: 'guest_add', user_id: user.other.id }), f.deps)).status).toBe(200)
    expect(f.rpcs('live_guest_set')).toEqual([{ sid: SID, target: user.other.id, on_stage: true }])
    expect(JSON.parse(f.calls.find(c => c.url.endsWith('/UpdateParticipant'))!.body)).toEqual({ room: 'room-abc', identity: user.other.id,
      permission: { can_subscribe: true, can_publish_data: true, can_publish: true, can_publish_sources: ['CAMERA', 'MICROPHONE'] } })
    const off = fake({ users: user, stream: [{ room: 'room-abc' }] })
    await handleLiveControl(authed('tok', { stream_id: SID, action: 'guest_remove', user_id: user.other.id }), off.deps)
    expect(JSON.parse(off.calls.find(c => c.url.endsWith('/UpdateParticipant'))!.body).permission).toMatchObject({ can_publish: false, can_publish_sources: [] })
    const n = fake({ users: user, stream: [] })
    expect((await handleLiveControl(authed('tok', { stream_id: SID, action: 'guest_add', user_id: user.other.id }), n.deps)).status).toBe(403)
    expect(n.rpcs('live_guest_set')).toHaveLength(0); expect(n.calls.some(c => c.url.endsWith('/UpdateParticipant'))).toBe(false)
  })
  it('stage: a guest can step down themselves', async () => {
    const f = fake({ users: user, stream: [{ room: 'room-abc' }] })
    expect((await handleLiveControl(authed('tok', { stream_id: SID, action: 'guest_leave' }), f.deps)).status).toBe(200)
    expect(f.rpcs('live_guest_leave')).toEqual([{ sid: SID }])
    expect(JSON.parse(f.calls.find(c => c.url.endsWith('/UpdateParticipant'))!.body)).toMatchObject({ identity: UID, permission: { can_publish: false } })
  })
  it('webhooks: only correctly signed bodies change stream state', async () => {
    const body = JSON.stringify({ event: 'room_started', room: { name: 'room-abc' } })
    const sha = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))))
    const tokenFor = async (extra: Record<string, unknown> = {}, secret = ENV.LIVEKIT_API_SECRET!) => {
      const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const head = enc({ alg: 'HS256', typ: 'JWT' }), pl = enc({ iss: 'APIkey', nbf: 1, exp: Math.floor(Date.now() / 1000) + 300, sha256: sha, ...extra })
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${head}.${pl}`))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return `${head}.${pl}.${sig}`
    }
    const send = (auth: string | null, b = body) => { const f = fake(); return handleLiveWebhook(new Request('https://fn/wh', { method: 'POST', headers: auth ? { authorization: auth } : {}, body: b }), f.deps).then(r => ({ r, f })) }
    const good = await send(await tokenFor()); expect(good.r.status).toBe(200); expect(good.f.rpcs('live_apply_event')).toEqual([{ p_room: 'room-abc', p_event: 'room_started' }])
    expect((await send(null)).r.status).toBe(401)
    expect((await send(await tokenFor({}, 'a-different-secret-a-different-secret!'))).r.status).toBe(401)
    expect((await send(await tokenFor({ iss: 'someone-else' }))).r.status).toBe(401)
    const tampered = await send(await tokenFor(), body.replace('room-abc', 'other-room')); expect(tampered.r.status).toBe(401); expect(tampered.f.rpcs('live_apply_event')).toHaveLength(0)
    const left = await send(await tokenFor({ sha256: undefined }), body); expect(left.r.status).toBe(401)
    const viewers = JSON.stringify({ event: 'participant_joined', room: { name: 'room-abc', numParticipants: 43 } })
    const sha2 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(viewers)))))
    const v = await send(await tokenFor({ sha256: sha2 }), viewers); expect(v.f.rpcs('live_apply_event')).toEqual([{ p_room: 'room-abc', p_event: 'viewers', p_viewers: 42 }])
  })
  it('token helpers: expired and wrongly signed tokens fail verification', async () => {
    const t = await signToken({ apiKey: 'k', secret: 'sss', video: {}, ttlSec: 10, now: 1_000_000 })
    expect(await verifyJwt(t, 'sss', 1_005_000)).not.toBeNull(); expect(await verifyJwt(t, 'sss', 2_000_000)).toBeNull(); expect(await verifyJwt(t, 'nope', 1_005_000)).toBeNull()
    expect(await verifyWebhook('garbage', '{}', 'k', 'sss')).toBe(false)
  })
})

describe('payout-account', () => {
  const bank = { holder: 'Beach Co (Pty) Ltd', bank: 'FNB', account_number: '62012345678', branch_code: '250655', account_type: 'cheque' }
  it('validates bank details', () => {
    expect(validateBank(bank)).toBeNull()
    expect(validateBank({ ...bank, account_number: '12ab' })).toMatch(/digits/); expect(validateBank({ ...bank, branch_code: '12' })).toMatch(/6 digits/)
    expect(validateBank({ ...bank, holder: '' })).toMatch(/holder/); expect(validateBank({ ...bank, account_type: 'gold' })).toMatch(/type/)
  })
  it('encrypts before storing: the database only ever sees ciphertext and the last four digits', async () => {
    const f = fake({ users: user, canFinance: true })
    const r = await handlePayoutAccount(authed('tok', { action: 'save', ...bank }), f.deps)
    expect(r.status).toBe(200)
    const write = f.calls.find(c => c.url.endsWith('/rest/v1/payout_accounts') && c.method === 'POST')!
    expect(write.headers.authorization).toContain('service-key')       // only the service role writes this table
    const row = JSON.parse(write.body)
    expect(row.account_last4).toBe('5678'); expect(row.status).toBe('pending'); expect(write.body).not.toContain('62012345678'); expect(write.body).not.toContain('250655')
    expect(await decryptJson(ENV.PAYOUT_ENC_KEY!, row.details_enc, row.id)).toEqual({ account_number: '62012345678', branch_code: '250655', account_type: 'cheque' })
    await expect(decryptJson(ENV.PAYOUT_ENC_KEY!, row.details_enc, 'another-account-id')).rejects.toThrow()       // bound to the account id
    await expect(decryptJson(newKeyB64(), row.details_enc, row.id)).rejects.toThrow()
    expect(f.calls.some(c => c.url.endsWith('/rest/v1/audit_log'))).toBe(true)
  })
  it('organizations: only owners and admins of that organization may change details', async () => {
    const org = 'oooooooo-0000-4000-8000-000000000009'.replace(/o/g, '7')
    expect((await handlePayoutAccount(authed('tok', { action: 'save', organization_id: org, ...bank }), fake({ users: user, canFinance: false }).deps)).status).toBe(403)
    expect((await handlePayoutAccount(authed('tok', { action: 'save', organization_id: org, ...bank }), fake({ users: user, canFinance: true, orgRole: 'editor' }).deps)).status).toBe(403)
    expect((await handlePayoutAccount(authed('tok', { action: 'save', organization_id: org, ...bank }), fake({ users: user, canFinance: true, orgRole: 'owner' }).deps)).status).toBe(200)
  })
  it('rejects bad input and unauthenticated calls; reveal is admin-only and audited', async () => {
    expect((await handlePayoutAccount(post({ action: 'save', ...bank }), fake({ users: user }).deps)).status).toBe(401)
    expect((await handlePayoutAccount(authed('tok', { action: 'save', ...bank, account_number: 'x' }), fake({ users: user }).deps)).status).toBe(400)
    const aid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
    const enc = await encryptJson(ENV.PAYOUT_ENC_KEY!, { account_number: '62012345678', branch_code: '250655', account_type: 'cheque' }, aid)
    const acct = { id: aid, holder: 'Beach Co', bank: 'FNB', status: 'pending', details_enc: enc }
    expect((await handlePayoutAccount(authed('tok', { action: 'reveal', account_id: aid }), fake({ users: user, isAdmin: false, account: acct }).deps)).status).toBe(403)
    const f = fake({ users: user, isAdmin: true, account: acct }); const r = await handlePayoutAccount(authed('tok', { action: 'reveal', account_id: aid }), f.deps)
    expect(await r.json()).toMatchObject({ holder: 'Beach Co', account_number: '62012345678', branch_code: '250655' })
    expect(f.calls.some(c => c.url.endsWith('/rest/v1/audit_log') && c.body.includes('payout_account.revealed'))).toBe(true)
    const nf = fake({ users: user }); nf.deps.env = { ...ENV, PAYOUT_ENC_KEY: undefined }; expect((await handlePayoutAccount(authed('tok', { action: 'save', ...bank }), nf.deps)).status).toBe(503)
  })
})
