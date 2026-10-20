import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { REFUND_LABEL, money, processRefund, type RefundRow } from '../lib/finance'
import { Empty, ErrorState, Spinner, errMsg, toast } from '../ui'
import { isMissingSchema } from '../lib/tickets'

/** Refund requests for one event or for all of an organization's events. Approve / decline, and push approved ones through. */
export function RefundQueue({ eventId, orgId }: { eventId?: string; orgId?: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  const list = useAsync(async () => {
    let q = supabase.from('refunds').select('id,order_id,kind,status,ticket_amount_cents,fee_amount_cents,reason,error,created_at,orders!inner(id,event_id,buyer,total_cents,events!inner(title,organization_id),profiles:buyer(username,display_name))')
      .in('status', ['requested', 'approved', 'processing', 'manual_required']).order('created_at').limit(100)
    if (eventId) q = q.eq('orders.event_id', eventId)
    if (orgId) q = q.eq('orders.events.organization_id', orgId)
    const { data, error } = await q
    if (error) { if (isMissingSchema(error)) return [] as RefundRow[]; throw error }
    return (data ?? []) as unknown as RefundRow[]
  }, [eventId, orgId])
  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id)
    try { await fn(); toast(ok); list.reload() } catch (e) { toast(errMsg(e)) } finally { setBusy(null) }
  }
  const decide = (r: RefundRow, approve: boolean) => act(r.id, async () => {
    const { error } = await supabase.rpc('decide_refund', { p_refund: r.id, p_approve: approve, p_note: '' })
    if (error) throw new Error(error.message)
    if (approve) await processRefund(r.id).catch(() => {})
  }, approve ? 'Refund approved' : 'Refund declined')

  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data?.length) return <Empty title="No refunds waiting">Requests from buyers appear here.</Empty>
  return (
    <div className="list">{list.data.map(r => (
      <div key={r.id} className="item stack" style={{ gap: 4 }}>
        <div className="row between"><span className="t-name">{r.orders?.events?.title}</span><span className="tag">{REFUND_LABEL[r.status] ?? r.status}</span></div>
        <div className="t-meta">{r.orders?.profiles?.display_name || r.orders?.profiles?.username} · {money(Number(r.ticket_amount_cents) + Number(r.fee_amount_cents))} · {r.kind.replace('_', ' ')}</div>
        {r.reason && <p className="t-support">“{r.reason}”</p>}
        {r.error && <p className="t-meta">Note: {r.error}</p>}
        <div className="row">
          {r.status === 'requested' && <><button className="btn primary sm" disabled={busy === r.id} onClick={() => decide(r, true)}>Approve</button><button className="btn sm" disabled={busy === r.id} onClick={() => decide(r, false)}>Decline</button></>}
          {r.status === 'approved' && <button className="btn sm" disabled={busy === r.id} onClick={() => act(r.id, () => processRefund(r.id), 'Refund sent')}>Process now</button>}
        </div>
      </div>))}</div>
  )
}
