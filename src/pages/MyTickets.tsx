import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { friendIds } from '../lib/posts'
import { formatEventTime } from '../lib/format'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast } from '../ui'
import type { PublicProfile } from '../lib/types'
import { money } from '../lib/finance'
import { TicketPass } from '../components/tickets/TicketPass'
import type { TicketDesign, TierKey } from '../lib/tickets'

interface T { id: string; status: string; transfers: number; event_id: string; events: { id: string; title: string; starts_at: string; timezone: string; venue: string | null; city: string | null } | null; ticket_types: { name: string; kind?: string; tier?: TierKey; accent?: string | null; design?: TicketDesign; perks?: string[] } | null }

export default function MyTickets() {
  const { uid } = useAuth()
  const [transfer, setTransfer] = useState<T | null>(null)
  useEffect(() => { document.title = 'My tickets · VYBE' }, [])
  const list = useAsync(async () => {
    const q = (cols: string) => supabase.from('tickets').select(`id,status,transfers,event_id,events(id,title,starts_at,timezone,venue,city),ticket_types(${cols})`).eq('owner', uid!).order('created_at', { ascending: false }).limit(100)
    let { data, error } = await q('name,kind,tier,accent,design,perks')
    if (error && /does not exist|schema cache/i.test(error.message)) ({ data, error } = await q('name'))          // before migration 32
    if (error) { if (/does not exist|schema cache/i.test(error.message)) return [] as T[]; throw error }
    return (data ?? []) as unknown as T[]
  }, [uid])
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 12 }}>My tickets</h1>
      {!list.data?.length ? <Empty title="No tickets yet" action={<Link className="btn primary" to="/app/discover">Find something to go to</Link>}>Tickets you buy or receive appear here with a QR code for the door.</Empty> : (
        <div className="stack passes">{list.data.map(t => (
          <TicketPass key={t.id} t={t} eventTitle={t.events?.title} when={t.events ? formatEventTime(t.events.starts_at, t.events.timezone) : undefined}
            where={[t.events?.venue, t.events?.city].filter(Boolean).join(', ') || undefined}
            actions={t.transfers < 1 ? <button className="btn ghost sm" onClick={() => setTransfer(t)}>Send to a friend</button> : undefined} />))}</div>
      )}
      <DoorDuties />
      <OrderHistory />
      {transfer && <TransferSheet t={transfer} onClose={done => { setTransfer(null); if (done) list.reload() }} />}
    </>
  )
}

function TransferSheet({ t, onClose }: { t: T; onClose: (done?: boolean) => void }) {
  const { uid } = useAuth()
  const [busy, setBusy] = useState(false)
  const friends = useAsync(async () => {
    const ids = await friendIds(uid!)
    if (!ids.length) return [] as PublicProfile[]
    const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path').in('id', ids)
    return (data ?? []) as PublicProfile[]
  }, [uid])
  const send = async (to: PublicProfile) => {
    if (busy || !confirm(`Send this ticket to ${to.display_name || to.username}? A ticket can only be transferred once.`)) return
    setBusy(true)
    const { error } = await supabase.rpc('transfer_ticket', { p_ticket: t.id, p_to: to.id })
    setBusy(false)
    if (error) return toast(errMsg(error))
    toast('Ticket sent'); onClose(true)
  }
  return (
    <Sheet title="Send to a friend" onClose={() => onClose()}>
      <p className="t-meta" style={{ marginBottom: 8 }}>Friends only, one transfer per ticket. It leaves your account immediately.</p>
      {friends.loading ? <Spinner /> : !friends.data?.length ? <p className="t-support">Add friends first.</p> : (
        <div className="list" style={{ maxHeight: '50vh', overflow: 'auto' }}>{friends.data.map(f => (
          <button key={f.id} className="item row link" style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }} disabled={busy} onClick={() => send(f)}>
            <Avatar size="sm" path={f.avatar_path} name={f.display_name || f.username} /><span>{f.display_name || f.username}</span></button>))}</div>
      )}
    </Sheet>
  )
}

function OrderHistory() {
  const { uid } = useAuth()
  const orders = useAsync(async () => {
    const { data, error } = await supabase.from('orders').select('id,status,total_cents,created_at,events(title)').eq('buyer', uid!).in('status', ['paid', 'partially_refunded', 'refunded', 'disputed', 'pending']).order('created_at', { ascending: false }).limit(30)
    if (error) { if (/does not exist|schema cache/i.test(error.message)) return [] as { id: string; status: string; total_cents: number; created_at: string; events: { title: string } | null }[]; throw error }
    return (data ?? []) as unknown as { id: string; status: string; total_cents: number; created_at: string; events: { title: string } | null }[]
  }, [uid])
  if (!orders.data?.length) return null
  return (
    <section aria-labelledby="oh" style={{ marginTop: 24 }}>
      <h2 id="oh" className="t-section">Orders &amp; receipts</h2>
      <div className="list">{orders.data.map(o => (
        <Link key={o.id} to={`/app/orders/${o.id}`} className="item row link">
          <span className="grow"><span className="t-name clamp-1" style={{ display: 'block' }}>{o.events?.title ?? 'Event'}</span><span className="t-meta">{new Date(o.created_at).toLocaleDateString()} · {o.status.replace('_', ' ')}</span></span>
          <span>{money(o.total_cents)}</span></Link>))}</div>
    </section>
  )
}

/** Events where someone added me to the door team: a shortcut to the scanner. */
function DoorDuties() {
  const { uid } = useAuth()
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('event_staff').select('event_id,events(id,title,starts_at,timezone,status)').eq('user_id', uid!).limit(20)
    if (error) return [] as { event_id: string; events: { id: string; title: string; starts_at: string; timezone: string; status: string } | null }[]
    return ((data ?? []) as unknown as { event_id: string; events: { id: string; title: string; starts_at: string; timezone: string; status: string } | null }[])
      .filter(r => r.events && r.events.status !== 'cancelled' && new Date(r.events.starts_at).getTime() > Date.now() - 2 * 86400_000)
  }, [uid])
  if (!list.data?.length) return null
  return (
    <section aria-labelledby="dd" style={{ marginTop: 24 }}>
      <h2 id="dd" className="t-section">Door duty</h2>
      <div className="list">{list.data.map(r => (
        <Link key={r.event_id} to={`/app/scan/${r.event_id}`} className="item row link"><span className="grow"><span className="t-name">{r.events!.title}</span><span className="t-meta" style={{ display: 'block' }}>{formatEventTime(r.events!.starts_at, r.events!.timezone)}</span></span><span className="t-meta">Open scanner ›</span></Link>))}</div>
    </section>
  )
}
