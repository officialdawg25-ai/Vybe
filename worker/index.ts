import { ozowCheckout, payfastCheckout, rands, toCents, verifyOzowHash, verifyPayfastSignature, pfEncode, type Env, type OrderRow } from './payments'

/**
 * VYBE edge worker: serves the SPA (static assets) and the payment endpoints under /api/pay/*.
 * The browser never sees a provider secret and never decides an amount: orders are priced by Postgres (create_order),
 * this worker only (1) signs a checkout for an existing pending order, and (2) turns a VERIFIED provider notification
 * into fulfill_order(). Secrets: see worker/README.md.
 */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

async function rest(env: Env, path: string, init: RequestInit = {}) {
  return fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
}
const rpc = (env: Env, fn: string, args: Record<string, unknown>) => rest(env, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

async function getOrder(env: Env, id: string): Promise<OrderRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const r = await rest(env, `/rest/v1/orders?id=eq.${id}&select=id,buyer,event_id,status,provider,total_cents,expires_at`)
  const rows = (await r.json()) as OrderRow[]
  return rows[0] ?? null
}

/** Verifies the caller's Supabase access token and returns their identity. */
async function whoami(env: Env, req: Request): Promise<{ id: string; email: string; name: string } | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = (await r.json()) as { id: string; email?: string; user_metadata?: { display_name?: string; username?: string } }
  return u.id && u.email ? { id: u.id, email: u.email, name: u.user_metadata?.display_name || u.user_metadata?.username || 'VYBE member' } : null
}

async function startPayment(env: Env, req: Request): Promise<Response> {
  const me = await whoami(env, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  const body = (await req.json().catch(() => ({}))) as { order_id?: string }
  const order = await getOrder(env, body.order_id ?? '')
  // The same answer for "not yours" and "does not exist": no probing of other people's orders.
  if (!order || order.buyer !== me.id) return json({ error: 'Order not found.' }, 404)
  if (order.status !== 'pending') return json({ error: `This order is ${order.status}.` }, 409)
  if (new Date(order.expires_at).getTime() < Date.now()) return json({ error: 'This order has expired. Please start again.' }, 410)
  if (order.total_cents <= 0 || !order.provider || order.provider === 'free') return json({ error: 'Nothing to pay.' }, 400)

  const ev = (await (await rest(env, `/rest/v1/events?id=eq.${order.event_id}&select=title`)).json()) as { title: string }[]
  const title = `Tickets: ${ev[0]?.title ?? 'VYBE event'}`
  if (order.provider === 'payfast') {
    if (!env.PAYFAST_MERCHANT_ID || !env.PAYFAST_MERCHANT_KEY) return json({ error: 'PayFast is not configured yet.' }, 503)
    return json(payfastCheckout(env, order, me, title))
  }
  if (!env.OZOW_SITE_CODE || !env.OZOW_PRIVATE_KEY) return json({ error: 'Ozow is not configured yet.' }, 503)
  return json(await ozowCheckout(env, order, me))
}

/** PayFast ITN. Four checks: signature, order exists and is ours to settle, amount equals what we priced, PayFast confirms it server-to-server. */
async function payfastItn(env: Env, req: Request): Promise<Response> {
  const raw = await req.text()
  const pairs = [...new URLSearchParams(raw).entries()]
  const get = (k: string) => pairs.find(([x]) => x === k)?.[1] ?? ''
  if (!verifyPayfastSignature(pairs, env.PAYFAST_PASSPHRASE)) return new Response('bad signature', { status: 400 })
  if (get('merchant_id') !== env.PAYFAST_MERCHANT_ID) return new Response('wrong merchant', { status: 400 })
  const order = await getOrder(env, get('m_payment_id'))
  if (!order || order.provider !== 'payfast') return new Response('unknown order', { status: 400 })

  const status = get('payment_status')
  if (status === 'CANCELLED' || status === 'FAILED') { await rpc(env, 'close_order', { p_order: order.id, p_status: status === 'CANCELLED' ? 'cancelled' : 'failed' }); return new Response('OK') }
  if (status !== 'COMPLETE') return new Response('OK')

  if (toCents(get('amount_gross')) !== Number(order.total_cents)) return new Response('amount mismatch', { status: 400 })   // never settle a different amount
  // Server-to-server confirmation: PayFast must say it sent this exact payload.
  const confirm = pairs.filter(([k]) => k !== 'signature').map(([k, v]) => `${k}=${pfEncode(v.trim())}`).join('&')
  const host = env.PAYFAST_SANDBOX === '1' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za'
  const v = await fetch(`https://${host}/eng/query/validate`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: confirm })
  if ((await v.text()).trim() !== 'VALID') return new Response('not validated', { status: 400 })

  const r = await rpc(env, 'fulfill_order', { p_order: order.id, p_provider: 'payfast', p_ref: get('pf_payment_id'), p_amount_cents: order.total_cents })
  return r.ok ? new Response('OK') : new Response('retry', { status: 500 })   // non-200 makes PayFast retry
}

async function ozowNotify(env: Env, req: Request): Promise<Response> {
  const p = new URLSearchParams(await req.text())
  if (!env.OZOW_PRIVATE_KEY || !(await verifyOzowHash(p, env.OZOW_PRIVATE_KEY))) return new Response('bad hash', { status: 400 })
  if (p.get('SiteCode') !== env.OZOW_SITE_CODE) return new Response('wrong site', { status: 400 })
  if ((p.get('IsTest') === 'true') !== (env.OZOW_IS_TEST === '1')) return new Response('mode mismatch', { status: 400 })   // test payments can never settle live orders
  const order = await getOrder(env, p.get('TransactionReference') ?? '')
  if (!order || order.provider !== 'ozow') return new Response('unknown order', { status: 400 })

  const status = p.get('Status')
  if (status === 'Cancelled' || status === 'Error' || status === 'Abandoned') { await rpc(env, 'close_order', { p_order: order.id, p_status: status === 'Cancelled' ? 'cancelled' : 'failed' }); return new Response('OK') }
  if (status !== 'Complete') return new Response('OK')
  if (toCents(p.get('Amount') ?? '') !== Number(order.total_cents) || p.get('CurrencyCode') !== 'ZAR') return new Response('amount mismatch', { status: 400 })

  if (env.OZOW_API_KEY) {   // belt and braces: ask Ozow directly
    const q = new URLSearchParams({ siteCode: env.OZOW_SITE_CODE!, transactionReference: order.id, isTest: env.OZOW_IS_TEST === '1' ? 'true' : 'false' })
    const r = await fetch(`https://api.ozow.com/GetTransactionByReference?${q}`, { headers: { ApiKey: env.OZOW_API_KEY, accept: 'application/json' } })
    const t = ((await r.json().catch(() => [])) as { status?: string; amount?: number }[])[0]
    if (!r.ok || t?.status !== 'Complete' || rands(Math.round(Number(t?.amount) * 100)) !== rands(order.total_cents)) return new Response('not confirmed', { status: 400 })
  }
  const r = await rpc(env, 'fulfill_order', { p_order: order.id, p_provider: 'ozow', p_ref: p.get('TransactionId') ?? order.id, p_amount_cents: order.total_cents })
  return r.ok ? new Response('OK') : new Response('retry', { status: 500 })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname === '/api/health') return json({ ok: true, payfast: Boolean(env.PAYFAST_MERCHANT_ID), ozow: Boolean(env.OZOW_SITE_CODE) })
        if (req.method === 'POST' && url.pathname === '/api/pay/start') return await startPayment(env, req)
        if (req.method === 'POST' && url.pathname === '/api/pay/payfast/itn') return await payfastItn(env, req)
        if (req.method === 'POST' && url.pathname === '/api/pay/ozow/notify') return await ozowNotify(env, req)
        return json({ error: 'Not found' }, 404)
      } catch { return json({ error: 'Something went wrong. Please try again.' }, 500) }
    }
    return env.ASSETS.fetch(req)
  },
  /** Cron: releases stock held by unpaid orders. */
  async scheduled(_e: unknown, env: Env) { await rpc(env, 'expire_orders', {}) },
}
