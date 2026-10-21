import { describe, expect, it } from 'vitest'
import { handleOzowNotify, handlePayStart, handlePayfastItn } from '../../supabase/functions/_shared/handlers/pay.ts'
import { payfastSignature } from '../../supabase/functions/_shared/payments.ts'
import type { Deps, Env } from '../../supabase/functions/_shared/http.ts'

const BID = '7c1d2e3f-0a5d-4e6f-9b7a-1c2d3e4f5a6b', UID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ENV: Env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon', APP_ORIGIN: 'https://vybe.test', PAYFAST_MERCHANT_ID: '10000100', PAYFAST_MERCHANT_KEY: 'mk', PAYFAST_PASSPHRASE: 'pass', PAYFAST_SANDBOX: '1', OZOW_SITE_CODE: 'TST', OZOW_PRIVATE_KEY: 'priv', OZOW_IS_TEST: '1' }
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const badge = (o: Record<string, unknown> = {}) => ({ id: BID, buyer: UID, status: 'pending', provider: 'payfast', total_cents: 4900, expires_at: FUTURE, ...o })

function fake(order = badge()) {
  const calls: { url: string; method: string; body: string }[] = []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input), body = typeof init.body === 'string' ? init.body : ''
    calls.push({ url, method: init.method ?? 'GET', body })
    const ok = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', ...h } })
    if (url.endsWith('/auth/v1/user')) return ok({ id: UID, email: 'a@b.co', user_metadata: { username: 'alice' } })
    if (url.includes('/rest/v1/rpc/')) return ok(null)
    if (url.includes('/rest/v1/orders') && (init.method ?? 'GET') === 'GET') return ok([])                 // not a ticket order
    if (url.includes('/rest/v1/badge_orders') && (init.method ?? 'GET') === 'GET') return url.includes('ip_hash=') ? ok([], 200, { 'content-range': '*/0' }) : ok([order])
    if (url.includes('/rest/v1/')) return ok([])
    if (url.includes('/query/validate')) return new Response('VALID')
    return ok({}, 404)
  }) as typeof fetch
  return { calls, deps: { env: ENV, fetch: f } as Deps, rpc: (n: string) => calls.filter(c => c.url.endsWith(`/rpc/${n}`)).map(c => JSON.parse(c.body || '{}')) }
}
const post = (b: unknown, h: Record<string, string> = {}) => new Request('https://fn/x', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) })

describe('VYBE Verified payments reuse the payment functions', () => {
  it('pay-start signs a PayFast form titled "VYBE Verified" that returns to the verification screen', async () => {
    const r = await handlePayStart(post({ order_id: BID }, { authorization: 'Bearer tok' }), fake().deps)
    const c = await r.json() as { fields: Record<string, string> }
    expect(r.status).toBe(200); expect(c.fields.item_name).toBe('VYBE Verified'); expect(c.fields.amount).toBe('49.00')
    expect(c.fields.return_url).toBe(`https://vybe.test/app/profile/settings/verified?order=${BID}`); expect(c.fields.cancel_url).toContain('cancelled=1')
    expect(c.fields.m_payment_id).toBe(BID)
  })
  it('pay-start refuses someone else’s badge order', async () => {
    const r = await handlePayStart(post({ order_id: BID }, { authorization: 'Bearer tok' }), fake(badge({ buyer: 'bbbbbbbb-0000-4000-8000-000000000002' })).deps)
    expect(r.status).toBe(404)
  })
  it('a validated, correctly priced PayFast notification fulfils the badge order (not a ticket order)', async () => {
    const f = fake()
    const fields: [string, string][] = Object.entries({ m_payment_id: BID, pf_payment_id: '555', payment_status: 'COMPLETE', amount_gross: '49.00', payment_method: 'cc', merchant_id: '10000100' })
    fields.push(['signature', payfastSignature(fields, 'pass')])
    const r = await handlePayfastItn(new Request('https://fn/itn', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }), f.deps)
    expect(r.status).toBe(200)
    expect(f.rpc('fulfill_badge_order')).toEqual([{ p_order: BID, p_provider: 'payfast', p_ref: '555', p_amount_cents: 4900 }])
    expect(f.rpc('fulfill_order')).toHaveLength(0)
  })
  it('a wrong amount never grants the badge', async () => {
    const f = fake()
    const fields: [string, string][] = Object.entries({ m_payment_id: BID, pf_payment_id: '555', payment_status: 'COMPLETE', amount_gross: '1.00', payment_method: 'cc', merchant_id: '10000100' })
    fields.push(['signature', payfastSignature(fields, 'pass')])
    const r = await handlePayfastItn(new Request('https://fn/itn', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }), f.deps)
    expect(r.status).toBe(400); expect(f.rpc('fulfill_badge_order')).toHaveLength(0)
  })
  it('a cancelled payment closes the badge order', async () => {
    const f = fake()
    const fields: [string, string][] = Object.entries({ m_payment_id: BID, pf_payment_id: '555', payment_status: 'CANCELLED', amount_gross: '49.00', merchant_id: '10000100' })
    fields.push(['signature', payfastSignature(fields, 'pass')])
    await handlePayfastItn(new Request('https://fn/itn', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }), f.deps)
    expect(f.rpc('close_badge_order')).toEqual([{ p_order: BID, p_status: 'cancelled' }])
  })
  it('an unsigned Ozow notification is rejected', async () => {
    const r = await handleOzowNotify(new Request('https://fn/oz', { method: 'POST', body: new URLSearchParams({ TransactionReference: BID, Status: 'Complete' }).toString() }), fake().deps)
    expect(r.status).toBe(400)
  })
})
