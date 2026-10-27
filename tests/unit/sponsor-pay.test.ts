import { describe, expect, it } from 'vitest'
import { handleOzowNotify, handlePayStart, handlePayfastItn } from '../../supabase/functions/_shared/handlers/pay.ts'
import { payfastSignature } from '../../supabase/functions/_shared/payments.ts'
import type { Deps, Env } from '../../supabase/functions/_shared/http.ts'

const SID = '9a1d2e3f-0a5d-4e6f-9b7a-1c2d3e4f5a6b', UID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ENV: Env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon', APP_ORIGIN: 'https://vybe.test', PAYFAST_MERCHANT_ID: '10000100', PAYFAST_MERCHANT_KEY: 'mk', PAYFAST_PASSPHRASE: 'pass', PAYFAST_SANDBOX: '1', OZOW_SITE_CODE: 'TST', OZOW_PRIVATE_KEY: 'priv', OZOW_IS_TEST: '1' }
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const sponsor = (o: Record<string, unknown> = {}) => ({ id: SID, buyer: UID, status: 'pending', provider: 'payfast', total_cents: 19900, expires_at: FUTURE, ...o })

function fake(order = sponsor()) {
  const calls: { url: string; method: string; body: string }[] = []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), body = typeof init.body === 'string' ? init.body : ''
    calls.push({ url, method: init.method ?? 'GET', body })
    const ok = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...h } })
    if (url.endsWith('/auth/v1/user')) return ok({ id: UID, email: 'a@b.co', user_metadata: { username: 'alice' } })
    if (url.includes('/rest/v1/rpc/')) return ok(null)
    if ((url.includes('/rest/v1/orders') || url.includes('/rest/v1/badge_orders')) && (init.method ?? 'GET') === 'GET') return ok([])      // not a ticket or badge order
    if (url.includes('/rest/v1/sponsor_orders') && (init.method ?? 'GET') === 'GET') return url.includes('ip_hash=') ? ok([], 200, { 'content-range': '*/0' }) : ok([order])
    if (url.includes('/rest/v1/')) return ok([])
    if (url.includes('/query/validate')) return new Response('VALID')
    return ok({}, 404)
  }) as typeof fetch
  return { calls, deps: { env: ENV, fetch: f } as Deps, rpc: (n: string) => calls.filter(c => c.url.endsWith(`/rpc/${n}`)).map(c => JSON.parse(c.body || '{}')) }
}
const post = (b: unknown, h: Record<string, string> = {}) => new Request('https://fn/x', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) })
const itn = (f: ReturnType<typeof fake>, over: Record<string, string> = {}) => {
  const fields: [string, string][] = Object.entries({ m_payment_id: SID, pf_payment_id: '777', payment_status: 'COMPLETE', amount_gross: '199.00', payment_method: 'cc', merchant_id: '10000100', ...over })
  fields.push(['signature', payfastSignature(fields, 'pass')])
  return handlePayfastItn(new Request('https://fn/itn', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }), f.deps)
}

describe('sponsored post (boost) payments reuse the payment functions', () => {
  it('pay-start signs a PayFast form titled "VYBE sponsored post" that returns to the Ads screen, and charges the stored price', async () => {
    const r = await handlePayStart(post({ order_id: SID }, { authorization: 'Bearer tok' }), fake().deps)
    const c = await r.json() as { fields: Record<string, string> }
    expect(r.status).toBe(200); expect(c.fields.item_name).toBe('VYBE sponsored post'); expect(c.fields.amount).toBe('199.00')
    expect(c.fields.return_url).toBe(`https://vybe.test/app/boost?order=${SID}`); expect(c.fields.cancel_url).toContain('cancelled=1')
    expect(c.fields.m_payment_id).toBe(SID)
  })
  it('pay-start refuses someone else’s boost order and never touches ticket-only checks', async () => {
    const f = fake(sponsor({ buyer: 'bbbbbbbb-0000-4000-8000-000000000002' }))
    expect((await handlePayStart(post({ order_id: SID }, { authorization: 'Bearer tok' }), f.deps)).status).toBe(404)
    const ok = fake()
    await handlePayStart(post({ order_id: SID }, { authorization: 'Bearer tok' }), ok.deps)
    expect(ok.calls.some(c => c.url.includes('/rest/v1/events'))).toBe(false)
  })
  it('the per-network attempt limit counts boost orders in their own table', async () => {
    const f = fake()
    await handlePayStart(post({ order_id: SID }, { authorization: 'Bearer tok', 'x-forwarded-for': '1.2.3.4' }), f.deps)
    expect(f.calls.some(c => c.url.includes('/rest/v1/sponsor_orders?ip_hash='))).toBe(true)
  })
  it('a validated, correctly priced PayFast notification fulfils the boost order only', async () => {
    const f = fake(); const r = await itn(f)
    expect(r.status).toBe(200)
    expect(f.rpc('fulfill_sponsor_order')).toEqual([{ p_order: SID, p_provider: 'payfast', p_ref: '777', p_amount_cents: 19900 }])
    expect(f.rpc('fulfill_order')).toHaveLength(0); expect(f.rpc('fulfill_badge_order')).toHaveLength(0)
  })
  it('a wrong amount never starts a boost', async () => {
    const f = fake(); const r = await itn(f, { amount_gross: '1.00' })
    expect(r.status).toBe(400); expect(f.rpc('fulfill_sponsor_order')).toHaveLength(0)
  })
  it('a cancelled or failed payment closes the boost order', async () => {
    const f = fake(); await itn(f, { payment_status: 'CANCELLED' })
    expect(f.rpc('close_sponsor_order')).toEqual([{ p_order: SID, p_status: 'cancelled' }]); expect(f.rpc('close_order')).toHaveLength(0)
  })
  it('an Ozow notification for a PayFast boost order is refused', async () => {
    const f = fake(); expect(handleOzowNotify).toBeTypeOf('function')
    const r = await itn(f, { payment_status: 'PENDING' })
    expect(r.status).toBe(200); expect(f.rpc('fulfill_sponsor_order')).toHaveLength(0)
  })
})
