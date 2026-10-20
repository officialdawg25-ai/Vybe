import { asUser, clientIp, dbError, json, need, preflight, service, sha256Hex, text, whoami, type Deps } from '../http.ts'
import { ozowCheckout, payfastCheckout, rands, toCents, verifyOzowHash, verifyPayfastSignature, pfEncode, type OrderRow } from '../payments.ts'

async function getOrder(deps: Deps, id: string): Promise<OrderRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const r = await service(deps).rest(`/rest/v1/orders?id=eq.${id}&select=id,buyer,event_id,status,provider,total_cents,expires_at`)
  const rows = (await r.json().catch(() => [])) as OrderRow[]
  return rows[0] ?? null
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
    const seen = await svc.rest(`/rest/v1/orders?ip_hash=eq.${ipHash}&created_at=gte.${since}&select=id`, { headers: { prefer: 'count=exact', range: '0-0' } })
    const count = Number((seen.headers.get('content-range') ?? '0/0').split('/')[1] ?? 0)
    if (count >= 12) return json({ error: 'Too many payment attempts from this network. Please wait a few minutes.' }, 429)
    await svc.rest(`/rest/v1/orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ ip_hash: ipHash }) })
  }

  const ev = (await (await svc.rest(`/rest/v1/events?id=eq.${order.event_id}&select=title`)).json().catch(() => [])) as { title: string }[]
  const title = `Tickets: ${ev[0]?.title ?? 'VYBE event'}`
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
  const order = await getOrder(deps, get('m_payment_id'))
  if (!order || order.provider !== 'payfast') return text('unknown order', 400)

  const svc = service(deps), status = get('payment_status')
  if (status === 'CANCELLED' || status === 'FAILED') { await svc.rpc('close_order', { p_order: order.id, p_status: status === 'CANCELLED' ? 'cancelled' : 'failed' }); return text('OK') }
  if (status !== 'COMPLETE') return text('OK')
  if (toCents(get('amount_gross')) !== Number(order.total_cents)) return text('amount mismatch', 400)

  const confirm = pairs.filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${pfEncode(v.trim())}`).join('&')
  const host = deps.env.PAYFAST_SANDBOX === '1' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'
  const v = await deps.fetch(`https://${host}/eng/query/validate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: confirm })
  if ((await v.text()).trim() !== 'VALID') return text('not validated', 400)

  const r = await svc.rpc('fulfill_order', { p_order: order.id, p_provider: 'payfast', p_ref: get('pf_payment_id'), p_amount_cents: order.total_cents, p_method: get('payment_method') || null })
  return r.ok ? text('OK') : text('retry', 500)
}

export async function handleOzowNotify(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return text('method not allowed', 405)
  const p = new URLSearchParams(await req.text())
  const key = deps.env.OZOW_PRIVATE_KEY
  if (!key || !(await verifyOzowHash(p, key))) return text('bad hash', 400)
  if (p.get('SiteCode') !== deps.env.OZOW_SITE_CODE) return text('wrong site', 400)
  if ((p.get('IsTest') === 'true') !== (deps.env.OZOW_IS_TEST === '1')) return text('mode mismatch', 400)    // test payments never settle live orders
  const order = await getOrder(deps, p.get('TransactionReference') ?? '')
  if (!order || order.provider !== 'ozow') return text('unknown order', 400)

  const svc = service(deps), status = p.get('Status')
  if (status === 'Cancelled' || status === 'Error' || status === 'Abandoned') { await svc.rpc('close_order', { p_order: order.id, p_status: status === 'Cancelled' ? 'cancelled' : 'failed' }); return text('OK') }
  if (status !== 'Complete') return text('OK')
  if (toCents(p.get('Amount') ?? '') !== Number(order.total_cents) || p.get('CurrencyCode') !== 'ZAR') return text('amount mismatch', 400)

  if (deps.env.OZOW_API_KEY) {    // belt and braces: ask Ozow directly
    const q = new URLSearchParams({ siteCode: deps.env.OZOW_SITE_CODE!, transactionReference: order.id, isTest: deps.env.OZOW_IS_TEST === '1' ? 'true' : 'false' })
    const r = await deps.fetch(`https://api.ozow.com/GetTransactionByReference?${q}`, { headers: { ApiKey: deps.env.OZOW_API_KEY, accept: 'application/json' } })
    const t = ((await r.json().catch(() => [])) as { status?: string; amount?: number }[])[0]
    if (!r.ok || t?.status !== 'Complete' || rands(Math.round(Number(t?.amount) * 100)) !== rands(order.total_cents)) return text('not confirmed', 400)
  }
  const r = await svc.rpc('fulfill_order', { p_order: order.id, p_provider: 'ozow', p_ref: p.get('TransactionId') ?? order.id, p_amount_cents: order.total_cents, p_method: 'eft' })
  return r.ok ? text('OK') : text('retry', 500)
}

export { asUser, dbError }
