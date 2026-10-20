import { asUser, json, preflight, service, whoami, type Deps } from '../http.ts'
import { payfastApiSignature, payfastTimestamp } from '../payments.ts'

interface RefundRow { id: string; order_id: string; requested_by: string; status: string; ticket_amount_cents: number; fee_amount_cents: number; reason: string }
interface OrderRow { id: string; event_id: string; provider: string | null; provider_ref: string | null; payment_method: string | null; status: string }

/**
 * POST {refund_id}. Allowed for the person who asked, the event's organizer, or an admin — and only once the refund is APPROVED.
 * The amount always comes from the database row, never from the request. PayFast card payments are refunded through
 * PayFast's API; anything else (EFT, Ozow) is flagged for a human to complete, so money is never silently stuck.
 */
export async function handleRefundProcess(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  const { refund_id } = (await req.json().catch(() => ({}))) as { refund_id?: string }
  if (!refund_id || !/^[0-9a-f-]{36}$/i.test(refund_id)) return json({ error: 'Missing refund.' }, 400)

  const user = asUser(deps, me.token), svc = service(deps)
  const mine = (await (await user.rest(`/rest/v1/refunds?id=eq.${refund_id}&select=id,order_id,requested_by,status,ticket_amount_cents,fee_amount_cents,reason`)).json().catch(() => [])) as RefundRow[]
  const refund = mine[0]
  if (!refund) return json({ error: 'Refund not found.' }, 404)       // RLS hides refunds you have no stake in
  if (refund.status !== 'approved') return json({ error: `This refund is ${refund.status}.` }, 409)

  const claimed = (await (await svc.rpc('refund_claim', { p_refund: refund.id })).json().catch(() => null)) as RefundRow | null
  if (!claimed || claimed.status !== 'processing') return json({ error: 'This refund is already being processed.' }, 409)

  const order = ((await (await svc.rest(`/rest/v1/orders?id=eq.${refund.order_id}&select=id,event_id,provider,provider_ref,payment_method,status`)).json().catch(() => [])) as OrderRow[])[0]
  const total = Number(claimed.ticket_amount_cents) + Number(claimed.fee_amount_cents)
  const finish = (status: string, provider: string | null, ref: string | null, error: string | null) => svc.rpc('refund_finish', { p_refund: refund.id, p_status: status, p_provider: provider, p_ref: ref, p_error: error })

  if (!order?.provider_ref) { await finish('manual_required', order?.provider ?? null, null, 'No gateway payment reference on file.'); return json({ status: 'manual_required' }) }
  if (total <= 0) { await finish('succeeded', 'none', null, null); return json({ status: 'succeeded' }) }

  if (order.provider === 'payfast' && order.payment_method === 'cc' && deps.env.PAYFAST_MERCHANT_ID) {
    try {
      const body = { amount: String(total), reason: (refund.reason || 'Refund').slice(0, 100), notify_buyer: '1' }
      const headers = { 'merchant-id': deps.env.PAYFAST_MERCHANT_ID, version: 'v1', timestamp: payfastTimestamp(new Date(deps.now?.() ?? Date.now())) }
      const signature = payfastApiSignature({ ...headers, ...body }, deps.env.PAYFAST_PASSPHRASE)
      const base = `https://api.payfast.co.za/refunds/${encodeURIComponent(order.provider_ref)}${deps.env.PAYFAST_SANDBOX === '1' ? '?testing=true' : ''}`
      const r = await deps.fetch(base, { method: 'POST', headers: { ...headers, signature, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
      const out = (await r.json().catch(() => ({}))) as { status?: string; data?: { response?: string; message?: string } | string }
      if (r.ok && out.status !== 'failed') { await finish('succeeded', 'payfast', order.provider_ref, null); return json({ status: 'succeeded' }) }
      const why = typeof out.data === 'string' ? out.data : out.data?.message ?? `PayFast returned ${r.status}`
      await finish('manual_required', 'payfast', null, String(why).slice(0, 300))          // do not guess: a person completes it
      return json({ status: 'manual_required', note: 'PayFast could not refund automatically. An admin will complete it.' })
    } catch {
      await finish('manual_required', 'payfast', null, 'Could not reach PayFast.')
      return json({ status: 'manual_required' })
    }
  }
  await finish('manual_required', order.provider, null, order.provider === 'ozow' ? 'Ozow refunds are completed from the Ozow dashboard.' : 'This payment method needs a manual refund.')
  return json({ status: 'manual_required', note: 'An admin will complete this refund and you will be notified.' })
}
