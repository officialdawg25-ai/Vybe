import { describe, expect, it } from 'vitest'
import { compose, handleEmailSend, oneLine, type Mail, type Outgoing } from '../../supabase/functions/_shared/handlers/email.ts'

const KEY = 'k'.repeat(64)
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', APP_ORIGIN: 'https://vybe.test', SMTP_HOST: 'smtp.test', SMTP_PORT: '465', SMTP_USERNAME: 'u', SMTP_PASSWORD: 'p', SMTP_FROM_EMAIL: 'tickets@vybe.test' }
const row = (o: Partial<Outgoing> = {}): Outgoing => ({ id: 1, type: 'ticket_order', entity_type: 'order', entity_id: 'o1', email: 'thandi@example.com', name: 'Thandi', event_title: 'Rooftop Sessions', order_status: 'paid', order_total_cents: 16050, payout_status: null, payout_amount_cents: null, review_status: null, ...o })

function world(batch: Outgoing[], claimStatus = 200) {
  const done: Record<string, unknown>[] = [], sent: Mail[] = []
  const fetchFake = (async (u: RequestInfo | URL, i: RequestInit = {}) => {
    const url = String(u), body = JSON.parse(String(i.body ?? '{}'))
    if (url.endsWith('/rpc/email_worker_claim')) return new Response(JSON.stringify(claimStatus === 200 ? batch : { message: 'forbidden' }), { status: claimStatus })
    if (url.endsWith('/rpc/email_worker_done')) { done.push(body); return new Response('null') }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { done, sent, deps: (send?: (m: Mail) => Promise<void>, env: Record<string, string> = ENV) => ({ env, fetch: fetchFake, send: send ?? (async (m: Mail) => { sent.push(m) }) }) }
}
const req = (key = KEY) => new Request('https://fn/email-send', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' })

describe('email messages', () => {
  it('paid order: amount, link to the order, plain text', () => {
    const m = compose(row(), 'https://vybe.test')!
    expect(m.subject).toBe('Your tickets for Rooftop Sessions')
    expect(m.text).toContain('R160.50'); expect(m.text).toContain('https://vybe.test/app/orders/o1'); expect(m.text.startsWith('Hi Thandi,')).toBe(true)
  })
  it('a title cannot inject headers or lines into the subject', () => {
    const m = compose(row({ event_title: 'Party\r\nBcc: everyone@example.com' }), 'https://x')!
    expect(m.subject).not.toMatch(/[\r\n]/); expect(oneLine('a\u0000b\nc')).toBe('a b c')
  })
  it('every queued type has a message; unknown types and missing addresses are skipped', () => {
    for (const t of ['ticket_order', 'refund_update', 'sales_review', 'payout_update', 'event_feedback', 'event_update', 'event_cancelled']) expect(compose(row({ type: t, entity_type: 'event' }), 'https://x')).not.toBeNull()
    expect(compose(row({ type: 'reaction' }), 'https://x')).toBeNull(); expect(compose(row({ email: null }), 'https://x')).toBeNull(); expect(compose(row({ email: 'nope' }), 'https://x')).toBeNull()
    expect(compose(row({ type: 'payout_update', entity_type: 'payout', payout_status: 'failed', payout_amount_cents: 250000 }), 'https://x')!.subject).toBe('Your payout of R2500.00 could not be paid')
  })
})

describe('email-send worker', () => {
  it('sends, skips and retries, reporting each row', async () => {
    const w = world([row(), row({ id: 2, email: null }), row({ id: 3 })])
    let n = 0
    const r = await handleEmailSend(req(), w.deps(async m => { if (++n === 2) throw new Error('421 try later'); w.sent.push(m) }))
    expect(await r.json()).toEqual({ claimed: 3, sent: 1, skipped: 1, failed: 1 })
    expect(w.done).toEqual([
      { p_key: KEY, p_id: 1, p_status: 'sent' },
      { p_key: KEY, p_id: 2, p_status: 'skipped', p_error: 'no email address' },
      { p_key: KEY, p_id: 3, p_status: 'pending', p_error: '421 try later' },
    ])
  })
  it('refuses short keys, missing configuration and blocked SMTP ports before claiming anything', async () => {
    const w = world([row()])
    expect((await handleEmailSend(req('short'), w.deps())).status).toBe(403)
    expect((await handleEmailSend(req(), w.deps(undefined, { ...ENV, SMTP_HOST: '' }))).status).toBe(503)
    const blocked = await handleEmailSend(req(), w.deps(undefined, { ...ENV, SMTP_PORT: '587' }))
    expect(blocked.status).toBe(503); expect((await blocked.json()).error).toMatch(/465/)
    expect(w.done).toHaveLength(0); expect(w.sent).toHaveLength(0)
  })
  it('a wrong key is refused by the database', async () => {
    const w = world([], 403)
    expect((await handleEmailSend(req(), w.deps())).status).toBe(403)
  })
})
