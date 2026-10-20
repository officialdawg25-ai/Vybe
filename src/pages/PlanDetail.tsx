import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CalendarDays, ExternalLink, Share2, Ticket } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { friendIds } from '../lib/posts'
import { PlanForm } from '../components/PlanForm'
import { LineupSection, LiveCard, ShareToFeed, TicketsSection, WhereCard } from '../components/EventExtras'
import { ReportSheet } from '../components/Report'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import { formatEventTime, formatPrice } from '../lib/format'
import type { EventRow, PublicProfile } from '../lib/types'

type Status = 'going' | 'maybe' | 'declined'
interface Rsvp { user_id: string; status: string; profiles: PublicProfile }

export default function PlanDetail() {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const [editing, setEditing] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [busy, submit] = useSubmit()

  const ev = useAsync(async () => {
    const { data, error } = await supabase.from('events').select('*, profiles:host(id,username,display_name,avatar_path)').eq('id', id!).maybeSingle()
    if (error) throw error
    return data as unknown as EventRow | null
  }, [id])
  const rsvps = useAsync(async () => {
    const { data, error } = await supabase.from('event_rsvps').select('user_id,status,profiles:user_id(id,username,display_name,avatar_path)').eq('event_id', id!).limit(500)
    if (error) throw error
    return (data ?? []) as unknown as Rsvp[]
  }, [id])
  const cover = useSigned(ev.data?.cover_path)
  const managed = useAsync(async () => { const { data } = await supabase.rpc('can_manage_event', { eid: id! }); return Boolean(data) }, [id])
  useEffect(() => { document.title = ev.data ? `${ev.data.title} · VYBE` : 'Plan · VYBE' }, [ev.data])

  if (ev.loading) return <Spinner />
  if (ev.error) return <ErrorState message={ev.error} onRetry={ev.reload} />
  const e = ev.data
  if (!e) return <Empty title="Plan not found">It may have been removed, or it's private and you haven't been invited.</Empty>
  if (editing) return <PlanForm initial={e} onSaved={() => { setEditing(false); ev.reload() }} onCancel={() => setEditing(false)} />

  const mine = rsvps.data?.find(r => r.user_id === uid)
  const going = rsvps.data?.filter(r => r.status === 'going') ?? []
  const isHost = e.host === uid
  const canManage = isHost || Boolean(managed.data)
  const full = e.capacity != null && going.length >= e.capacity && mine?.status !== 'going'
  const cancelled = e.status === 'cancelled'

  const rsvp = (status: Status) => submit(async () => {
    const { error } = mine
      ? await supabase.from('event_rsvps').update({ status }).eq('event_id', e.id).eq('user_id', uid!)
      : await supabase.from('event_rsvps').insert({ event_id: e.id, user_id: uid, status })
    if (error) return toast(error.message.includes('capacity') ? 'This plan is full.' : errMsg(error))
    rsvps.reload()
  })
  const cancelPlan = async () => {
    if (!confirm('Cancel this plan? Attendees will see it as cancelled.')) return
    const { error } = await supabase.from('events').update({ status: 'cancelled' }).eq('id', e.id)
    if (error) toast(errMsg(error)); else ev.reload()
  }
  const share = async () => {
    const url = `${window.location.origin}/app/plans/${e.id}`
    if (navigator.share) { try { await navigator.share({ url, title: e.title }) } catch { /* dismissed */ } } else { await navigator.clipboard.writeText(url); toast('Link copied') }
  }
  const del = async () => { if (confirm('Delete this plan permanently?')) { const { error } = await supabase.from('events').delete().eq('id', e.id); if (error) toast(errMsg(error)); else nav('/app/plans', { replace: true }) } }

  return (
    <>
      {cover && <div className="cover" style={{ marginBottom: 16 }}><img src={cover} alt="" /></div>}
      {cancelled && <p className="notice err" role="status" style={{ marginBottom: 12 }}>This plan has been cancelled.</p>}
      <h1 className="t-title">{e.title}</h1>
      <p className="t-meta" style={{ margin: '4px 0 16px' }}>Hosted by <Link to={`/app/u/${e.profiles.username}`}><b>{e.profiles.display_name || e.profiles.username}</b></Link>{e.visibility !== 'public' && ` · ${e.visibility === 'invite' ? 'Invite only' : 'Friends'}`}</p>
      <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
        <p className="row"><CalendarDays size={18} aria-hidden /> <span>{formatEventTime(e.starts_at, e.timezone)}{e.ends_at && ` – ${formatEventTime(e.ends_at, e.timezone)}`}</span></p>
        <p className="row"><Ticket size={18} aria-hidden /> <span>{formatPrice(e.price_cents, e.currency)}{e.capacity ? ` · ${going.length}/${e.capacity} going` : ` · ${going.length} going`}</span></p>
        {e.ticket_url && <p className="t-meta">Tickets are sold by an external provider; VYBE does not process this payment. <a href={e.ticket_url} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: 'var(--brand)', fontWeight: 600 }}>Open ticket link <ExternalLink size={12} aria-hidden /></a></p>}
      </div>
      {e.description && <p style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>{e.description}</p>}
      <WhereCard e={e} />
      <LineupSection eventId={e.id} manage={canManage} />
      <LiveCard eventId={e.id} />
      {!cancelled && <TicketsSection e={e} manage={canManage} />}

      {!cancelled && !isHost && (
        <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
          {mine?.status === 'invited' && <p className="notice">You're invited. Will you come?</p>}
          <div className="row" role="group" aria-label="Your RSVP" style={{ flexWrap: 'wrap' }}>
            {(['going', 'maybe', 'declined'] as Status[]).map(s => (
              <button key={s} className={`btn${mine?.status === s ? ' primary' : ''}`} aria-pressed={mine?.status === s} disabled={busy || (s === 'going' && full)} onClick={() => rsvp(s)}>
                {{ going: full ? 'Full' : 'Going', maybe: 'Maybe', declined: "Can't go" }[s]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 24 }}>
        <button className="btn sm" onClick={share}><Share2 size={16} aria-hidden /> Share link</button>
        <ShareToFeed e={e} />
        {isHost && !cancelled && <><button className="btn sm" onClick={() => setInviting(true)}>Invite friends</button><button className="btn sm" onClick={() => setEditing(true)}>Edit</button><button className="btn sm danger" onClick={cancelPlan}>Cancel plan</button></>}
        {isHost && <button className="btn ghost sm danger" onClick={del}>Delete</button>}
        {!isHost && <button className="btn ghost sm" onClick={() => setReporting(true)}>Report</button>}
      </div>

      <h2 className="t-section">Going ({going.length})</h2>
      {rsvps.loading ? <Spinner /> : going.length === 0 ? <p className="t-support" style={{ padding: '8px 0' }}>No one yet — be the first.</p> : (
        <div className="list">{going.map(r => <Link key={r.user_id} to={`/app/u/${r.profiles.username}`} className="item row link"><Avatar size="sm" path={r.profiles.avatar_path} name={r.profiles.display_name || r.profiles.username} /><span className="clamp-1">{r.profiles.display_name || r.profiles.username}</span></Link>)}</div>
      )}
      {inviting && <InviteSheet eventId={e.id} already={new Set(rsvps.data?.map(r => r.user_id))} onClose={() => { setInviting(false); rsvps.reload() }} />}
      {reporting && <ReportSheet target={{ type: 'event', id: e.id }} onClose={() => setReporting(false)} />}
    </>
  )
}

function InviteSheet({ eventId, already, onClose }: { eventId: string; already: Set<string>; onClose: () => void }) {
  const { uid } = useAuth()
  const [sel, setSel] = useState<string[]>([])
  const [busy, submit] = useSubmit()
  const friends = useAsync(async () => {
    const ids = await friendIds(uid!)
    if (!ids.length) return [] as PublicProfile[]
    const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path').in('id', ids)
    return (data ?? []) as PublicProfile[]
  }, [uid])
  const send = () => submit(async () => {
    const { error } = await supabase.from('event_rsvps').insert(sel.map(user_id => ({ event_id: eventId, user_id, status: 'invited' })))
    if (error) return toast(errMsg(error))
    toast(`Invited ${sel.length} ${sel.length === 1 ? 'friend' : 'friends'}`); onClose()
  })
  const options = (friends.data ?? []).filter(f => !already.has(f.id))
  return (
    <Sheet title="Invite friends" onClose={onClose}>
      {friends.loading ? <Spinner /> : options.length === 0 ? <p className="t-support">No friends left to invite.</p> : (
        <div className="list" style={{ maxHeight: '50vh', overflow: 'auto' }}>{options.map(f => (
          <label key={f.id} className="item row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.includes(f.id)} onChange={() => setSel(c => c.includes(f.id) ? c.filter(x => x !== f.id) : [...c, f.id])} />
            <Avatar size="sm" path={f.avatar_path} name={f.display_name || f.username} /><span>{f.display_name || f.username}</span>
          </label>))}</div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !sel.length} onClick={send}>Send invites</button></div>
    </Sheet>
  )
}
