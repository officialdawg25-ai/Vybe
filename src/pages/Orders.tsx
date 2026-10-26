import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CalendarPlus, Check, Clock, Receipt as ReceiptIcon, RotateCcw, Share2, Ticket as TicketIcon, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { money } from '../lib/tickets'
import { Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast } from '../ui'
import { REFUND_LABEL, requestRefund } from '../lib/finance'
import { playSound } from '../lib/sounds'
import { downloadIcs } from '../lib/discover'
import { formatEventTime } from '../lib/format'
import { ProviderLogo } from '../components/brand/PaymentMarks'
import { TicketPass, type PassTicket } from '../components/tickets/TicketPass'

interface Ev { id: string; title: string; starts_at: string; ends_at: string | null; timezone: string; venue: string | null; address: string | null; city: string | null; online_url: string | null }
interface Order { id: string; status: string; total_cents: number; fee_cents: number; subtotal_cents: number; provider: string | null; event_id: string; created_at: string; paid_at: string | null; events: Ev | null }

/**
 * Where PayFast / Ozow send people back to. The provider's signed notification (not this page) is what marks an order
 * paid; this page shows the wait, then a branded confirmation with the tickets themselves (branded QR included).
 */
export default function OrderPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const order = useAsync(async () => {
    const { data, error } = await supabase.from('orders').select('id,status,total_cents,fee_cents,subtotal_cents,provider,event_id,created_at,paid_at,events(id,title,starts_at,ends_at,timezone,venue,address,city,online_url)').eq('id', id!).maybeSingle()
    if (error) throw error
    return data as unknown as Order | null
  }, [id])
  const status = order.data?.status
  const tickets = useAsync(async () => {
    if (status !== 'paid' && status !== 'partially_refunded') return [] as PassTicket[]
    const q = (cols: string) => supabase.from('tickets').select(`id,status,ticket_types(${cols})`).eq('order_id', id!).order('created_at')
    let { data, error } = await q('name,kind,tier,accent,design,perks')
    if (error) ({ data, error } = await q('name'))
    return (data ?? []) as unknown as PassTicket[]
  }, [id, status])
  const refund = useAsync(async () => {
    const { data } = await supabase.from('refunds').select('id,status,error').eq('order_id', id!).in('status', ['requested', 'approved', 'processing', 'manual_required', 'succeeded', 'rejected']).order('created_at', { ascending: false }).limit(1)
    return ((data ?? [])[0] ?? null) as { id: string; status: string; error: string | null } | null
  }, [id, status])
  const [asking, setAsking] = useState(false)
  const [waited, setWaited] = useState(0)
  useEffect(() => { document.title = status === 'paid' ? 'You’re going! · VYBE' : 'Order · VYBE' }, [status])
  useEffect(() => {
    if (status !== 'pending' || params.get('cancelled')) return
    const t = window.setInterval(() => { order.reload(); setWaited(w => w + 3) }, 3000)          // the provider notifies our server; poll until it lands
    const stop = window.setTimeout(() => window.clearInterval(t), 90_000)
    return () => { window.clearInterval(t); window.clearTimeout(stop) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])
  useEffect(() => { if (status === 'paid') playSound('success') }, [status])

  if (order.loading && !order.data) return <Spinner />
  if (order.error) return <ErrorState message={order.error} onRetry={order.reload} />
  const o = order.data
  if (!o) return <Empty title="Order not found">It may belong to another account.</Empty>
  const cancelled = params.get('cancelled') || o.status === 'cancelled'
  const paid = o.status === 'paid' || o.status === 'partially_refunded'
  const ev = o.events
  const provider = o.provider === 'ozow' ? 'ozow' : o.provider === 'payfast' ? 'payfast' : null
  const share = async () => {
    const url = `${window.location.origin}/app/plans/${o.event_id}`
    try { if (navigator.share) await navigator.share({ title: ev?.title, text: `I’m going to ${ev?.title}! Come with me 🎟️`, url }); else { await navigator.clipboard.writeText(url); toast('Link copied') } } catch { /* closed */ }
  }
  return (
    <div className={`paid-page${paid ? ' is-paid' : ''}`}>
      {paid ? (
        <section className="pay-hero ok" role="status">
          <div className="pay-confetti" aria-hidden>{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ ['--i' as string]: i }} />)}</div>
          <div className="pay-ring" aria-hidden><Check size={44} strokeWidth={3} /></div>
          <p className="pay-kicker">Payment successful</p>
          <h1 className="pay-title">You’re going{ev ? <> to <span>{ev.title}</span></> : ''}!</h1>
          <p className="pay-sub">{money(o.total_cents)} paid{provider ? <> with <ProviderLogo provider={provider} height={16} /></> : ''} · Order {o.id.slice(0, 8).toUpperCase()}</p>
        </section>
      ) : cancelled ? (
        <section className="pay-hero off" role="status">
          <div className="pay-ring" aria-hidden><XCircle size={40} /></div>
          <p className="pay-kicker">Payment cancelled</p><h1 className="pay-title">No money was taken</h1>
          <p className="pay-sub">Your tickets were released. You can try again any time while they’re still available.</p>
        </section>
      ) : o.status === 'pending' ? (
        <section className="pay-hero wait" role="status" aria-live="polite">
          <div className="pay-ring spin" aria-hidden><Clock size={36} /></div>
          <p className="pay-kicker">Almost there</p><h1 className="pay-title">Confirming your payment…</h1>
          <ol className="co-steps pay-steps">
            <li className="done"><Check size={14} aria-hidden /> Tickets held for you</li>
            <li className="now"><span className="dot" /> Waiting for {provider === 'ozow' ? 'Ozow' : 'PayFast'} to confirm</li>
            <li><span className="dot" /> Issuing your tickets</li>
          </ol>
          <p className="pay-sub">{waited >= 60 ? 'This is taking longer than usual. You can leave this page; your tickets will appear in My tickets and we’ll notify you.' : 'This usually takes a few seconds. You can leave this page.'}</p>
        </section>
      ) : (
        <section className="pay-hero bad" role="alert">
          <div className="pay-ring" aria-hidden><XCircle size={40} /></div>
          <p className="pay-kicker">Order {o.status}</p><h1 className="pay-title">This didn’t go through</h1>
          <p className="pay-sub">{o.status === 'failed' ? 'If money left your account, contact support with your order number and it will be returned.' : 'Start again from the event page.'}</p>
        </section>
      )}

      {paid && (tickets.data?.length ? (
        <section className="paid-tickets" aria-label="Your tickets">
          {tickets.data.map((t, i) => <TicketPass key={t.id} t={t} eventTitle={ev?.title} when={ev ? formatEventTime(ev.starts_at, ev.timezone) : undefined}
            where={[ev?.venue, ev?.city].filter(Boolean).join(', ') || undefined} startOpen={i === 0} />)}
        </section>
      ) : tickets.loading ? <Spinner /> : null)}

      {paid && ev && (
        <div className="paid-actions">
          <button className="paid-act" onClick={() => downloadIcs({ ...ev, online_url: ev.online_url })}><CalendarPlus size={20} aria-hidden /><span>Add to calendar</span></button>
          <button className="paid-act" onClick={() => void share()}><Share2 size={20} aria-hidden /><span>Invite friends</span></button>
          <Link className="paid-act" to="/app/tickets"><TicketIcon size={20} aria-hidden /><span>My tickets</span></Link>
          <Link className="paid-act" to={`/app/orders/${o.id}/receipt`}><ReceiptIcon size={20} aria-hidden /><span>Receipt</span></Link>
        </div>
      )}

      <section className="card paid-summary">
        <p className="t-name">{ev?.title ?? 'Event'}</p>
        <p className="t-meta">Order {o.id.slice(0, 8).toUpperCase()} · {o.provider === 'free' ? 'Free' : provider === 'ozow' ? 'Ozow' : 'PayFast'}</p>
        <div className="row between" style={{ marginTop: 8 }}><span>Tickets</span><span>{money(o.subtotal_cents)}</span></div>
        {o.fee_cents > 0 && <div className="row between"><span>Service fee</span><span>{money(o.fee_cents)}</span></div>}
        <div className="row between t-name"><span>Total</span><span>{money(o.total_cents)}</span></div>
      </section>
      {refund.data && <p className="notice" role="status">Refund: <b>{REFUND_LABEL[refund.data.status] ?? refund.data.status}</b>{refund.data.error ? ` — ${refund.data.error}` : ''}</p>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {!paid && ['refunded'].includes(o.status) && <Link className="btn" to={`/app/orders/${o.id}/receipt`}>Receipt</Link>}
        {paid && !refund.data && <button className="btn ghost sm" onClick={() => setAsking(true)}><RotateCcw size={14} aria-hidden /> Request a refund</button>}
        <Link className="btn ghost sm" to={`/app/plans/${o.event_id}`}>Back to the event</Link>
      </div>
      {asking && <RefundSheet orderId={o.id} onClose={done => { setAsking(false); if (done) { refund.reload(); order.reload() } }} />}
    </div>
  )
}

function RefundSheet({ orderId, onClose }: { orderId: string; onClose: (done?: boolean) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true); setErr('')
    try {
      const r = await requestRefund(orderId, reason.trim())
      toast(r.status === 'approved' ? 'Refund approved — it will reach you shortly' : 'Refund requested. The organizer will review it.')
      onClose(true)
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Sheet title="Request a refund" onClose={() => onClose()}>
      <p className="t-support" style={{ marginBottom: 12 }}>Tickets you haven’t used can be refunded. Up to 48 hours before the event it’s approved automatically; after that the organizer decides. Any VYBE service fee is refunded only if the event is cancelled or its date or venue changes.</p>
      <Field id="rf-why" label="Reason (optional)"><textarea id="rf-why" className="textarea" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => onClose()} disabled={busy}>Back</button><button className="btn primary" onClick={go} disabled={busy}>{busy ? 'Please wait…' : 'Request refund'}</button></div>
    </Sheet>
  )
}
