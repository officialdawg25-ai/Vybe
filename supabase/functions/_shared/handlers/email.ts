import { bearer, json, need, service, type Deps } from '../http.ts'
import { rands } from '../payments.ts'

/**
 * Transactional email for VYBE Tickets (migration 29). The database queues one row per ticket/money notification; this
 * worker claims a batch with its key, writes a plain-text message (no HTML, so nothing a user typed can become markup),
 * sends it over SMTP and reports each result. Called every minute by pg_cron while something is waiting.
 */
export interface Outgoing { id: number; type: string; entity_type: string | null; entity_id: string | null; email: string | null; name: string | null
  event_title: string | null; order_status: string | null; order_total_cents: number | null; payout_status: string | null; payout_amount_cents: number | null; review_status: string | null }
export interface Mail { to: string; subject: string; text: string }
export type Send = (m: Mail) => Promise<void>
export interface EmailDeps extends Deps { send?: Send }

/** One line, no control characters (no header injection), bounded. */
export const oneLine = (s: string, max = 150) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export function compose(o: Outgoing, origin: string): Mail | null {
  if (!o.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) return null
  const ev = oneLine(o.event_title ?? 'your event', 80)
  const hi = `Hi ${oneLine(o.name ?? 'there', 60)},`
  const link = (path: string) => `${origin}${path}`
  const order = o.entity_id && o.entity_type === 'order' ? link(`/app/orders/${o.entity_id}`) : link('/app/tickets')
  const event = o.entity_id && o.entity_type === 'event' ? link(`/app/plans/${o.entity_id}`) : link('/app/plans')
  const amount = (c: number | null) => (c == null ? '' : `R${rands(Number(c))}`)
  let subject = '', body = ''
  switch (o.type) {
    case 'ticket_order':
      if (o.order_status === 'paid') { subject = `Your tickets for ${ev}`; body = `Your payment of ${amount(o.order_total_cents)} was received and your tickets are ready.\n\nOpen your tickets: ${order}\n\nYour ticket QR code is your entry pass. Don't share it publicly.` }
      else if (o.order_status === 'failed') { subject = `Your payment for ${ev} didn't go through`; body = `The payment for your order didn't complete, so no tickets were issued and you were not charged by VYBE.\n\nOrder details: ${order}` }
      else { subject = `Update on your order for ${ev}`; body = `There is an update on your order.\n\nOrder details: ${order}` }
      break
    case 'refund_update':
      subject = `Update on your refund for ${ev}`; body = `There is news about a refund on your order.\n\nSee the details: ${order}`; break
    case 'sales_review':
      subject = o.review_status === 'approved' ? `Ticket sales approved for ${ev}` : `Ticket sales review for ${ev}`
      body = o.review_status === 'approved' ? `VYBE has approved paid ticket sales for your event.\n\n${event}`
        : o.review_status === 'suspended' ? `Paid ticket sales for your event are paused. Existing tickets stay valid unless you are told otherwise.\n\nSee why: ${event}`
        : `VYBE reviewed ticket sales for your event.\n\nSee the decision: ${event}`
      break
    case 'payout_update':
      subject = o.payout_status === 'paid' ? `Your payout of ${amount(o.payout_amount_cents)} was sent` : o.payout_status === 'failed' ? `Your payout of ${amount(o.payout_amount_cents)} could not be paid` : 'Update on your payout'
      body = o.payout_status === 'failed' ? `We could not complete this payout. The amount is available in your balance again; check your bank details and the reason in the app.\n\n${link('/app/earnings')}`
        : `See your payouts and statement: ${link('/app/earnings')}`
      break
    case 'event_feedback':
      subject = `News about a complaint for ${ev}`; body = `There is a new message about a complaint for this event.\n\nOpen it: ${event}`; break
    case 'event_update':
      subject = `${ev} has changed`; body = `An event you have tickets for has changed. Check the new details. If the date or venue changed after you bought, you can get your money back from My tickets.\n\n${event}`; break
    case 'event_cancelled':
      subject = `${ev} was cancelled`; body = `An event you have tickets for was cancelled. Paid tickets are refunded; you can follow the refund in My tickets.\n\n${link('/app/tickets')}`; break
    default:
      return null
  }
  return { to: o.email, subject: oneLine(subject), text: `${hi}\n\n${body}\n\n— VYBE\nYou get this email because of a ticket or payment on VYBE.` }
}

export async function handleEmailSend(req: Request, deps: EmailDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const key = bearer(req)
  if (key.length < 32) return json({ error: 'forbidden' }, 403)
  const missing = need(deps.env, 'APP_ORIGIN', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM_EMAIL')
  if (missing.length || !deps.send) return json({ error: `Email is not configured: ${missing.join(', ') || 'no transport'}` }, 503)
  const port = Number(deps.env.SMTP_PORT)
  if (port === 25 || port === 587) return json({ error: 'Supabase Edge Functions cannot connect to SMTP ports 25 or 587. Set SMTP_PORT to 465 (TLS).' }, 503)
  const svc = service(deps)
  const claim = await svc.rpc('email_worker_claim', { p_key: key, p_limit: 20 })
  if (claim.status === 401 || claim.status === 403) return json({ error: 'forbidden' }, 403)
  if (!claim.ok) return json({ error: 'claim failed' }, 502)
  const batch = ((await claim.json().catch(() => [])) ?? []) as Outgoing[]
  const origin = deps.env.APP_ORIGIN!.replace(/\/$/, '')
  let sent = 0, skipped = 0, failed = 0
  for (const o of batch) {
    const m = compose(o, origin)
    if (!m) { skipped++; await svc.rpc('email_worker_done', { p_key: key, p_id: o.id, p_status: 'skipped', p_error: o.email ? 'no template' : 'no email address' }); continue }
    try { await deps.send(m); sent++; await svc.rpc('email_worker_done', { p_key: key, p_id: o.id, p_status: 'sent' }) }
    catch (e) { failed++; await svc.rpc('email_worker_done', { p_key: key, p_id: o.id, p_status: 'pending', p_error: oneLine(String((e as Error)?.message ?? e), 300) }) }   // retried, up to 5 attempts
  }
  return json({ claimed: batch.length, sent, skipped, failed })
}
