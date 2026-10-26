import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { friendIds } from '../lib/posts'
import { formatEventTime } from '../lib/format'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast } from '../ui'
import type { PublicProfile } from '../lib/types'
import { money } from '../lib/finance'
import { myTicketCode } from '../lib/trust'

interface T { id: string; status: string; transfers: number; event_id: string; events: { id: string; title: string; starts_at: string; timezone: string; venue: string | null; city: string | null } | null; ticket_types: { name: string } | null }

/** The code is fetched only when the holder opens it (organisers and door staff can never read codes). */
function Qr({ ticketId }: { ticketId: string }) {
  const [code, setCode] = useState<string | null | undefined>(undefined)
  const [src, setSrc] = useState('')
  useEffect(() => {
    let live = true
    void (async () => {
      let c = await myTicketCode(ticketId)
      if (c == null) {                                         // a server before migration 28 still lets the holder read it directly
        const { data } = await supabase.from('tickets').select('code').eq('id', ticketId).maybeSingle()
        c = (data as { code?: string } | null)?.code ?? null
      }
      if (live) setCode(c)
    })()
    return () => { live = false }
  }, [ticketId])
  useEffect(() => { if (code) QRCode.toDataURL(code, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(setSrc, () => setSrc('')) }, [code])
  if (code === null) return <p className="t-support">This ticket can’t be shown right now. Refresh, or contact support if it persists.</p>
  return (
    <>
      {src ? <img className="qr" src={src} alt="QR code for your ticket" width={200} height={200} /> : <div className="skeleton" style={{ width: 200, height: 200, margin: '0 auto' }} />}
      {code && <p className="t-meta" style={{ marginTop: 4, letterSpacing: '.08em' }}>{code.match(/.{1,5}/g)?.join(' ')}</p>}
    </>
  )
}
const STATUS: Record<string, string> = { valid: 'Valid', used: 'Used', void: 'Void', refunded: 'Refunded' }

export default function MyTickets() {
  const { uid } = useAuth()
  const [open, setOpen] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<T | null>(null)
  useEffect(() => { document.title = 'My tickets · VYBE' }, [])
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('tickets').select('id,status,transfers,event_id,events(id,title,starts_at,timezone,venue,city),ticket_types(name)').eq('owner', uid!).order('created_at', { ascending: false }).limit(100)
    if (error) { if (/does not exist|schema cache/i.test(error.message)) return [] as T[]; throw error }
    return (data ?? []) as unknown as T[]
  }, [uid])
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 12 }}>My tickets</h1>
      {!list.data?.length ? <Empty title="No tickets yet" action={<Link className="btn primary" to="/app/discover">Find something to go to</Link>}>Tickets you buy or receive appear here with a QR code for the door.</Empty> : (
        <div className="stack">{list.data.map(t => (
          <article key={t.id} className="card ticket">
            <div className="row between"><div><div className="t-name">{t.events?.title}</div><div className="t-meta">{t.ticket_types?.name}{t.events ? ` · ${formatEventTime(t.events.starts_at, t.events.timezone)}` : ''}</div><div className="t-meta">{[t.events?.venue, t.events?.city].filter(Boolean).join(', ')}</div></div>
              <span className={`tag${t.status === 'valid' ? '' : ' muted'}`}>{STATUS[t.status] ?? t.status}</span></div>
            {t.status === 'valid' && (
              <>
                <button className="btn sm" style={{ marginTop: 8 }} aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Hide QR code' : 'Show QR code'}</button>
                {open === t.id && <div style={{ textAlign: 'center', padding: 12 }}><Qr ticketId={t.id} /><p className="t-meta">Show this at the door. The door checks it live, so a screenshot of a ticket that was already used, refunded or transferred will not get in. Don’t share it publicly.</p></div>}
                {t.transfers < 1 && <button className="btn ghost sm" onClick={() => setTransfer(t)}>Send to a friend</button>}
              </>)}
          </article>))}</div>
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
