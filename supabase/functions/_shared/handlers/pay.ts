import { asUser, clientIp, dbError, json, need, preflight, service, sha256Hex, text, whoami, type Deps } from '../http.ts'
import { ozowCheckout, payfastCheckout, rands, toCents, verifyOzowHash, verifyPayfastSignature, pfEncode, type OrderRow } from '../payments.ts'

/** A payment reference is a ticket order, a VYBE Verified (badge) order or a post boost (sponsor) order; each lives in its own table with the same shape. */
async function getOrder(deps: Deps, id: string): Promise<OrderRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const svc = service(deps)
  const rows = (await (await svc.rest(`/rest/v1/orders?id=eq.${id}&select=id,buyer,event_id,status,provider,total_cents,expires_at`)).json().catch(() => [])) as OrderRow[]
  if (rows[0]) return { ...rows[0], kind: 'ticket' }
  const badge = (await (await svc.rest(`/rest/v1/badge_orders?id=eq.${id}&select=id,buyer,status,provider,total_cents,expires_at`)).json().catch(() => [])) as OrderRow[]
  if (badge[0]) return { ...badge[0], event_id: null, kind: 'badge' }
  const sponsor = (await (await svc.rest(`/rest/v1/sponsor_orders?id=eq.${id}&select=id,buyer,status,provider,total_cents,expires_at`)).json().catch(() => [])) as OrderRow[]
  return sponsor[0] ? { ...sponsor[0], event_id: null, kind: 'sponsor' } : null
}
/** The table each kind of order lives in (used for the per-network attempt limit). */
const tableOf = (o: OrderRow) => (o.kind === 'badge' ? 'badge_orders' : o.kind === 'sponsor' ? 'sponsor_orders' : 'orders')
const fulfil = (svc: ReturnType<typeof service>, o: OrderRow, provider: string, ref: string, method: string | null) =>
  o.kind === 'badge' ? svc.rpc('fulfill_badge_order', { p_order: o.id, p_provider: provider, p_ref: ref, p_amount_cents: o.total_cents })
    : o.kind === 'sponsor' ? svc.rpc('fulfill_sponsor_order', { p_order: o.id, p_provider: provider, p_ref: ref, p_amount_cents: o.total_cents })
    : svc.rpc('fulfill_order', { p_order: o.id, p_provider: provider, p_ref: ref, p_amount_cents: o.total_cents, p_method: method })
const close = (svc: ReturnType<typeof service>, o: OrderRow, status: string) =>
  o.kind === 'badge' ? svc.rpc('close_badge_order', { p_order: o.id, p_status: status })
    : o.kind === 'sponsor' ? svc.rpc('close_sponsor_order', { p_order: o.id, p_status: status })
    : svc.rpc('close_order', { p_order: o.id, p_status: status })

/**
 * Every verified notification is recorded once per (provider, transaction, status) with what we did about it, so a person
 * can always answer "did we hear from the gateway, and what happened?". Best effort: recording never blocks settling an
 * order (that step is idempotent on its own), and a server without migration 28 simply has nowhere to record.
 */
type Svc = ReturnType<typeof service>
async function noteReceived(svc: Svc, provider: string, txn: string, status: string, orderRef: string, amountCents: number | null, currency: string): Promise<number | null> {
  try {
    const r = await svc.rpc('record_payment_notification', { p_provider: provider, p_txn: txn, p_status: status, p_order_ref: orderRef.slice(0, 80), p_amount_cents: amountCents, p_currency: currency })
    if (!r.ok) return null
    const j = (await r.json().catch(() => null)) as { id?: number } | null
    return typeof j?.id === 'number' ? j.id : null
  } catch { return null }
}
const noteOutcome = async (svc: Svc, id: number | null, outcome: 'fulfilled' | 'closed' | 'ignored' | 'amount_mismatch' | 'not_confirmed' | 'unknown_order' | 'error') => {
  if (id == null) return
  try { await svc.rpc('finish_payment_notification', { p_id: id, p_outcome: outcome }) } catch { /* recorded as received; reconciliation still sees the order */ }
}

/** POST {order_id} (signed-in buyer) → a signed checkout form for the order's payment provider. */
export async function handlePayStart(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  const body = (await req.json().catch(() => ({}))) as { order_id?: string }
  const order = await getOrder(deps, body.order_id ?? '')
  // Same answer for "not yours" and "does not exist": no probing of other people's orders.
  if (!order || order.buyer !== me.id) return json({ error: 'Order not found.' }, 404)
  if (order.status !== 'pending') return json({ error: `This order is ${order.status}.` }, 409)
  if (new Date(order.expires_at).getTime() < (deps.now?.() ?? Date.now())) return json({ error: 'This order has expired. Please start again.' }, 410)
  if (order.total_cents <= 0 || !order.provider || order.provider === 'free') return json({ error: 'Nothing to pay.' }, 400)

  // Per-network velocity: many orders from one address in a few minutes is card-testing or hoarding, whoever the user is.
  const svc = service(deps)
  const ip = clientIp(req)
  if (ip) {
    const ipHash = (await sha256Hex(`${ip}:${deps.env.SUPABASE_SERVICE_ROLE_KEY}`)).slice(0, 32)
    const since = new Date((deps.now?.() ?? Date.now()) - 10 * 60_000).toISOString()
    const table = tableOf(order)
    const seen = await svc.rest(`/rest/v1/${table}?ip_hash=eq.${ipHash}&created_at=gte.${since}&select=id`, { headers: { prefer: 'count=exact', range: '0-0' } })
    const count = Number((seen.headers.get('content-range') ?? '0/0').split('/')[1] ?? 0)
    if (count >= 12) return json({ error: 'Too many payment attempts from this network. Please wait a few minutes.' }, 429)
    await svc.rest(`/rest/v1/${table}?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ ip_hash: ipHash }) })
  }

  let ev: { title: string; sales_review?: string; status?: string }[] = []
  if (order.kind === 'ticket') {
    const withReview = await svc.rest(`/rest/v1/events?id=eq.${order.event_id}&select=title,status,sales_review`)
    ev = withReview.ok ? ((await withReview.json().catch(() => [])) as typeof ev)
      : ((await (await svc.rest(`/rest/v1/events?id=eq.${order.event_id}&select=title`)).json().catch(() => [])) as typeof ev)   // before migration 28
    // Sales can be suspended (or the event cancelled) after the order was made: never start taking money then.
    if (ev[0]?.status === 'cancelled') return json({ error: 'This event has been cancelled.' }, 409)
    if (ev[0]?.sales_review !== undefined && ev[0].sales_review !== 'approved') return json({ error: 'Ticket sales for this event are paused while VYBE reviews it.' }, 409)
  }
  const title = order.kind === 'badge' ? 'VYBE Verified' : order.kind === 'sponsor' ? 'VYBE sponsored post' : `Tickets: ${ev[0]?.title ?? 'VYBE event'}`
  if (order.provider === 'payfast') {
    if (need(deps.env, 'PAYFAST_MERCHANT_ID', 'PAYFAST_MERCHANT_KEY', 'APP_ORIGIN').length) return json({ error: 'PayFast is not configured yet.' }, 503)
    return json(payfastCheckout(deps.env, order, me, title))
  }
  if (need(deps.env, 'OZOW_SITE_CODE', 'OZOW_PRIVATE_KEY', 'APP_ORIGIN').length) return json({ error: 'Ozow is not configured yet.' }, 503)
  return json(await ozowCheckout(deps.env, order, me))
}

/**
 * PayFast ITN. A ticket is issued only after: signature matches, merchant matches, the order exists and was meant for PayFast,
 * the amount equals what Postgres priced, and PayFast confirms the payload server-to-server. Non-200 makes PayFast retry.
 */
export async function handlePayfastItn(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return text('method not allowed', 405)
  const raw = await req.text()
  const pairs = [...new URLSearchParams(raw).entries()]
  const get = (k: string) => pairs.find(([x]) => x === k)?.[1] ?? ''
  if (!verifyPayfastSignature(pairs, deps.env.PAYFAST_PASSPHRASE)) return text('bad signature', 400)
  if (get('merchant_id') !== deps.env.PAYFAST_MERCHANT_ID) return text('wrong merchant', 400)
  const svc = service(deps), status = get('payment_status')
  const amount = toCents(get('amount_gross'))
  const noteId = await noteReceived(svc, 'payfast', get('pf_payment_id'), status || 'UNKNOWN', get('m_payment_id'), Number.isFinite(amount) ? amount : null, 'ZAR')
  const order = await getOrder(deps, get('m_payment_id'))
  if (!order || order.provider !== 'payfast') { await noteOutcome(svc, noteId, 'unknown_order'); return text('unknown order', 400) }

  if (status === 'CANCELLED' || status === 'FAILED') { await close(svc, order, status === 'CANCELLED' ? 'cancelled' : 'failed'); await noteOutcome(svc, noteId, 'closed'); return text('OK') }
  if (status !== 'COMPLETE') { await noteOutcome(svc, noteId, 'ignored'); return text('OK') }
  if (amount !== Number(order.total_cents)) { await noteOutcome(svc, noteId, 'amount_mismatch'); return text('amount mismatch', 400) }

  const confirm = pairs.filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${pfEncode(v.trim())}`).join('&')
  const host = deps.env.PAYFAST_SANDBOX === '1' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'
  const v = await deps.fetch(`https://${host}/eng/query/validate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: confirm })
  if ((await v.text()).trim() !== 'VALID') { await noteOutcome(svc, noteId, 'not_confirmed'); return text('not validated', 400) }

  const r = await fulfil(svc, order, 'payfast', get('pf_payment_id'), get('payment_method') || null)
  await noteOutcome(svc, noteId, r.ok ? 'fulfilled' : 'error')
  if (r.ok && order.kind === 'ticket') await noteFee(svc, order.id, get('pf_payment_id'), get('amount_fee'))
  return r.ok ? text('OK') : text('retry', 500)
}

/**
 * PayFast reports its own fee as amount_fee (sent negative, e.g. "-4.60"). It is VYBE's processing cost, booked once per
 * payment in the journal (migration 30). Best effort: a failure here never makes PayFast resend a settled payment.
 */
async function noteFee(svc: Svc, orderId: string, txn: string, raw: string) {
  const fee = toCents(raw.trim().replace(/^-/, ''))
  if (!txn || !Number.isFinite(fee) || fee <= 0) return
  try { await svc.rpc('record_processing_fee', { p_order: orderId, p_provider: 'payfast', p_txn: txn, p_fee_cents: fee }) } catch { /* reconciliation can still be done from statements */ }
}

export async function handleOzowNotify(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return text('method not allowed', 405)
  const p = new URLSearchParams(await req.text())
  const key = deps.env.OZOW_PRIVATE_KEY
  if (!key || !(await verifyOzowHash(p, key))) return text('bad hash', 400)
  if (p.get('SiteCode') !== deps.env.OZOW_SITE_CODE) return text('wrong site', 400)
  if ((p.get('IsTest') === 'true') !== (deps.env.OZOW_IS_TEST === '1')) return text('mode mismatch', 400)    // test payments never settle live orders
  const svc = service(deps), status = p.get('Status') ?? ''
  const amount = toCents(p.get('Amount') ?? '')
  const noteId = await noteReceived(svc, 'ozow', p.get('TransactionId') ?? '', status || 'Unknown', p.get('TransactionReference') ?? '', Number.isFinite(amount) ? amount : null, p.get('CurrencyCode') ?? '')
  const order = await getOrder(deps, p.get('TransactionReference') ?? '')
  if (!order || order.provider !== 'ozow') { await noteOutcome(svc, noteId, 'unknown_order'); return text('unknown order', 400) }

  if (status === 'Cancelled' || status === 'Error' || status === 'Abandoned') { await close(svc, order, status === 'Cancelled' ? 'cancelled' : 'failed'); await noteOutcome(svc, noteId, 'closed'); return text('OK') }
  if (status !== 'Complete') { await noteOutcome(svc, noteId, 'ignored'); return text('OK') }
  if (amount !== Number(order.total_cents) || p.get('CurrencyCode') !== 'ZAR') { await noteOutcome(svc, noteId, 'amount_mismatch'); return text('amount mismatch', 400) }

  if (deps.env.OZOW_API_KEY) {    // belt and braces: ask Ozow directly
    const q = new URLSearchParams({ siteCode: deps.env.OZOW_SITE_CODE!, transactionReference: order.id, isTest: deps.env.OZOW_IS_TEST === '1' ? 'true' : 'false' })
    const r = await deps.fetch(`https://api.ozow.com/GetTransactionByReference?${q}`, { headers: { ApiKey: deps.env.OZOW_API_KEY, accept: 'application/json' } })
    const t = ((await r.json().catch(() => [])) as { status?: string; amount?: number }[])[0]
    if (!r.ok || t?.status !== 'Complete' || rands(Math.round(Number(t?.amount) * 100)) !== rands(order.total_cents)) { await noteOutcome(svc, noteId, 'not_confirmed'); return text('not confirmed', 400) }
  }
  const r = await fulfil(svc, order, 'ozow', p.get('TransactionId') ?? order.id, 'eft')
  await noteOutcome(svc, noteId, r.ok ? 'fulfilled' : 'error')
  return r.ok ? text('OK') : text('retry', 500)
}

export { asUser, dbError }
