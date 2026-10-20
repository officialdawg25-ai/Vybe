import { useEffect } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { money } from '../lib/tickets'
import { Empty, ErrorState, Spinner } from '../ui'
import { playSound } from '../lib/sounds'

interface Order { id: string; status: string; total_cents: number; fee_cents: number; subtotal_cents: number; provider: string | null; event_id: string; created_at: string; events: { id: string; title: string } | null }

/** Where PayFast / Ozow send people back to. The webhook (not this page) is what marks an order paid; we just wait for it. */
export default function OrderPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const order = useAsync(async () => {
    const { data, error } = await supabase.from('orders').select('id,status,total_cents,fee_cents,subtotal_cents,provider,event_id,created_at,events(id,title)').eq('id', id!).maybeSingle()
    if (error) throw error
    return data as unknown as Order | null
  }, [id])
  useEffect(() => { document.title = 'Order · VYBE' }, [])
  const status = order.data?.status
  useEffect(() => {
    if (status !== 'pending' || params.get('cancelled')) return
    const t = window.setInterval(() => order.reload(), 3000)          // the provider notifies our server; poll until it lands
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
  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      <h1 className="t-title">Your order</h1>
      {o.status === 'paid' ? <p className="notice ok row" role="status"><CheckCircle2 size={20} aria-hidden /> Payment received. Your tickets are ready.</p>
        : cancelled ? <p className="notice" role="status"><XCircle size={18} aria-hidden /> Payment was cancelled. Nothing was charged.</p>
        : o.status === 'pending' ? <p className="notice row" role="status"><Clock size={20} aria-hidden /> Waiting for your payment provider to confirm. This usually takes a few seconds. You can leave this page.</p>
        : <p className="notice err" role="alert"><XCircle size={18} aria-hidden /> This order is {o.status}. {o.status === 'failed' && 'If money left your account, contact support with this order number.'}</p>}
      <section className="card">
        <p className="t-name">{o.events?.title ?? 'Event'}</p>
        <p className="t-meta">Order {o.id.slice(0, 8).toUpperCase()} · {o.provider === 'free' ? 'Free' : o.provider === 'ozow' ? 'Ozow' : 'PayFast'}</p>
        <div className="row between" style={{ marginTop: 8 }}><span>Tickets</span><span>{money(o.subtotal_cents)}</span></div>
        <div className="row between"><span>Service fee</span><span>{money(o.fee_cents)}</span></div>
        <div className="row between t-name"><span>Total</span><span>{money(o.total_cents)}</span></div>
      </section>
      <div className="row">
        {o.status === 'paid' && <Link className="btn primary" to="/app/tickets">View my tickets</Link>}
        <Link className="btn" to={`/app/plans/${o.event_id}`}>Back to the event</Link>
      </div>
    </div>
  )
}
