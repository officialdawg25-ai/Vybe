import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, CalendarPlus, ExternalLink, Globe, MapPin, Share2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { friendIds } from '../lib/posts'
import { PlanForm } from '../components/PlanForm'
import { LineupSection, LiveCard, ShareToFeed, TicketsSection, WhereCard } from '../components/EventExtras'
import { FollowButton } from '../components/discover/FollowButton'
import { RefundQueue } from '../components/RefundQueue'
import { processApprovedForEvent } from '../lib/finance'
import { ReportSheet } from '../components/Report'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import { directionsUrl } from '../lib/cities'
import { dayOfWeek, downloadIcs, eventSocial, fullDate, setSaved, startTime, useCategories, type Social } from '../lib/discover'
import { formatPrice } from '../lib/format'
import { playSound } from '../lib/sounds'
import type { EventRow, PublicProfile } from '../lib/types'

type Status = 'going' | 'maybe' | 'declined'
type Vis = 'public' | 'friends' | 'private'
interface Rsvp { user_id: string; status: string; profiles: PublicProfile }
interface OrgBrief { id: string; name: string; slug: string; kind: string; verified_at: string | null }

export default function PlanDetail() {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const cats = useCategories()
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
  const social = useAsync<Social | null>(() => eventSocial(id!), [id])
  const org = useAsync(async () => {
    if (!ev.data?.organization_id) return null
    const { data } = await supabase.from('organizations').select('id,name,slug,kind,verified_at').eq('id', ev.data.organization_id).maybeSingle()
    return (data ?? null) as OrgBrief | null
  }, [ev.data?.organization_id])
  const hostFollow = useAsync(async () => {
    if (!ev.data || ev.data.host === uid) return false
    const { data } = await supabase.from('follows').select('follower').eq('follower', uid!).eq('target_type', 'profile').eq('target_id', ev.data.host).maybeSingle()
    return Boolean(data)
  }, [ev.data?.host, uid])
  const orgFollow = useAsync(async () => {
    if (!ev.data?.organization_id) return false
    const { data } = await supabase.from('follows').select('follower').eq('follower', uid!).eq('target_type', 'organization').eq('target_id', ev.data.organization_id).maybeSingle()
    return Boolean(data)
  }, [ev.data?.organization_id, uid])
  const cover = useSigned(ev.data?.cover_path)
  const managed = useAsync(async () => { const { data } = await supabase.rpc('can_manage_event', { eid: id! }); return Boolean(data) }, [id])
  useEffect(() => { document.title = ev.data ? `${ev.data.title} · VYBE` : 'Plan · VYBE' }, [ev.data])

  if (ev.loading) return <Spinner />
  if (ev.error) return <ErrorState message={ev.error} onRetry={ev.reload} />
  const e = ev.data
  if (!e) return <Empty title="Plan not found">It may have been removed, or it's private and you haven't been invited.</Empty>
  if (editing) return <PlanForm initial={e} onSaved={() => { setEditing(false); ev.reload() }} onCancel={() => setEditing(false)} />

  const sc = social.data
  const mineStatus = sc?.mine?.status ?? rsvps.data?.find(r => r.user_id === uid)?.status
  const mineVis: Vis = (sc?.mine?.visibility as Vis) ?? 'friends'
  const goingCount = sc?.going ?? rsvps.data?.filter(r => r.status === 'going').length ?? 0
  const interestedCount = sc?.interested ?? rsvps.data?.filter(r => r.status === 'maybe').length ?? 0
  const going = rsvps.data?.filter(r => r.status === 'going') ?? []
  const isHost = e.host === uid
  const canManage = isHost || Boolean(managed.data)
  const full = e.capacity != null && goingCount >= e.capacity && mineStatus !== 'going'
  const cancelled = e.status === 'cancelled'
  const isDraft = e.status === 'draft'
  const format = e.format ?? 'in_person'
  const categoryLabel = cats.find(c => c.slug === e.category)?.label
  const attending = canManage || mineStatus === 'going'
  const dirs = format !== 'online' ? directionsUrl(e, 'google') : null
  const past = new Date(e.ends_at ?? e.starts_at).getTime() < Date.now()
  const eyebrow = cancelled ? 'CANCELLED' : `${past ? 'Past' : 'Upcoming'} ${(categoryLabel ?? 'plan').toLowerCase()}`.toUpperCase()
  const where = [e.venue, e.city].filter(Boolean).join(' · ') || (format === 'online' ? 'Online' : e.location || '')

  const rsvp = (status: Status) => submit(async () => {
    const { error } = mineStatus
      ? await supabase.from('event_rsvps').update({ status }).eq('event_id', e.id).eq('user_id', uid!)
      : await supabase.from('event_rsvps').insert({ event_id: e.id, user_id: uid, status })
    if (error) return toast(error.message.includes('capacity') ? 'This plan is full.' : errMsg(error))
    if (status !== 'declined') playSound('success')
    rsvps.reload(); social.reload()
  })
  const setVisibility = (visibility: Vis) => submit(async () => {
    const { error } = await supabase.from('event_rsvps').update({ visibility }).eq('event_id', e.id).eq('user_id', uid!)
    if (error) return toast(errMsg(error))
    social.reload(); rsvps.reload()
  })
  const toggleSave = () => submit(async () => {
    try { await setSaved(e.id, uid!, !sc?.saved); playSound(sc?.saved ? 'unlike' : 'like'); social.reload() } catch (x) { toast(errMsg(x)) }
  })
  const publish = () => submit(async () => {
    if (format !== 'in_person' && !e.online_url) return toast('Add the online link before publishing.')
    const { error } = await supabase.from('events').update({ status: 'active' }).eq('id', e.id)
    if (error) return toast(errMsg(error))
    toast('Published. People who follow you have been notified.'); ev.reload()
  })
  const cancelPlan = async () => {
    const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('event_id', e.id).in('status', ['paid', 'partially_refunded'])
    if (count) {
      if (!confirm(`Cancel this plan? ${count} paid ${count === 1 ? 'order' : 'orders'} will be refunded in full, service fees included.`)) return
      const { error } = await supabase.rpc('cancel_event_with_refunds', { p_event: e.id })
      if (error) return toast(errMsg(error))
      const r = await processApprovedForEvent(e.id)
      toast(`Plan cancelled. ${r.done} refunded${r.manual ? `, ${r.manual} being completed by VYBE staff` : ''}${r.failed ? `, ${r.failed} will retry` : ''}.`); ev.reload(); return
    }
    if (!confirm('Cancel this plan? Attendees will be told it was cancelled.')) return
    const { error } = await supabase.from('events').update({ status: 'cancelled' }).eq('id', e.id)
    if (error) toast(errMsg(error)); else ev.reload()
  }
  const share = async () => {
    const url = `${window.location.origin}/app/plans/${e.id}`
    if (navigator.share) { try { await navigator.share({ url, title: e.title }) } catch { /* dismissed */ } } else { await navigator.clipboard.writeText(url); toast('Link copied') }
  }
  const del = async () => { if (confirm('Delete this plan permanently?')) { const { error } = await supabase.from('events').delete().eq('id', e.id); if (error) toast(errMsg(error)); else nav('/app/plans', { replace: true }) } }
  const toTickets = () => { const el = document.getElementById('tickets-anchor'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); else if (e.ticket_url) window.open(e.ticket_url, '_blank', 'noopener,noreferrer') }

  return (
    <>
      <header className="ev-hero" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        <span className="ev-back"><button className="icon-btn" aria-label="Back" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/app/discover'))}><ArrowLeft size={22} /></button></span>
        <div className="ev-hero-copy">
          <span className="ev-eyebrow">{eyebrow}</span>
          <h1>{e.title}</h1>
          <p className="ev-hero-meta">{fullDate(e.starts_at, e.timezone)}{where ? ` | ${where}` : ''}</p>
          <div className="ev-hero-actions">
            <button className="btn" onClick={toTickets}>{e.price_cents === 0 || (!e.ticket_url && e.price_cents == null) ? 'Details' : 'Tickets'}</button>
            <button className="btn" aria-pressed={Boolean(sc?.saved)} disabled={busy || !sc} onClick={toggleSave}>{sc?.saved ? 'Saved' : '+ Save'}</button>
          </div>
        </div>
      </header>

      {isDraft && <div className="notice" role="status" style={{ marginBottom: 12 }}><b>Draft.</b> Only you and your organisation’s editors can see this. {canManage && <button className="btn sm primary" style={{ marginLeft: 8 }} disabled={busy} onClick={publish}>Publish</button>}</div>}
      {cancelled && <p className="notice err" role="status" style={{ marginBottom: 12 }}>This plan has been cancelled.</p>}
      {e.source === 'external' && e.source_url && <p className="notice" style={{ marginBottom: 12 }}>Listed by {e.source_name ?? 'an external provider'} and not independently verified by VYBE. <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow" style={{ textDecoration: 'underline' }}>View original listing</a></p>}

      <section className="guide" aria-label="Event guide">
        <div className="guide-row">
          <div className="grow"><span className="t-meta">{dayOfWeek(e.starts_at, e.timezone)}</span><b>{fullDate(e.starts_at, e.timezone)} · Starts at {startTime(e.starts_at, e.timezone)}</b></div>
          <button className="guide-act" aria-label="Add to calendar" onClick={() => downloadIcs({ ...e, venue: e.venue, address: e.address, city: e.city, online_url: attending ? e.online_url : null })}><CalendarPlus size={24} aria-hidden /></button>
        </div>
        {format !== 'online' && (e.venue || e.address || e.location || e.lat != null) && (
          <div className="guide-row">
            <div className="grow"><span className="t-meta">{e.city || 'Location'}</span><b>{[e.venue, e.address].filter(Boolean).join(', ') || e.location}</b></div>
            {dirs && <a className="guide-act" href={dirs} target="_blank" rel="noopener noreferrer" aria-label="Open directions in Google Maps"><MapPin size={24} aria-hidden /></a>}
          </div>
        )}
        {format !== 'in_person' && (
          <div className="guide-row">
            <div className="grow"><span className="t-meta">{format === 'hybrid' ? 'Also online' : 'Online event'}</span>
              {e.online_url && attending ? <b><a href={e.online_url} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: 'var(--brand)' }}>Join online <ExternalLink size={14} aria-hidden /></a></b> : <b>Link shared with people who are going</b>}
            </div>
            <span className="guide-act" aria-hidden><Globe size={24} /></span>
          </div>
        )}
        <div className="guide-row">
          <div className="grow"><span className="t-meta">Price</span><b>{formatPrice(e.price_cents, e.currency)}</b>{e.ticket_url && <span className="t-meta">Tickets are sold by an external provider; VYBE does not process this payment. <a href={e.ticket_url} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: 'var(--brand)', fontWeight: 600 }}>Open the ticket page <ExternalLink size={12} aria-hidden /></a></span>}</div>
        </div>
      </section>

      <section className="guide" aria-label="Hosted by">
        <div className="guide-row">
          <Avatar size="sm" path={e.profiles.avatar_path} name={e.profiles.display_name || e.profiles.username} />
          <div className="grow"><span className="t-meta">Hosted by</span><b><Link to={`/app/u/${e.profiles.username}`}>{e.profiles.display_name || e.profiles.username}</Link></b></div>
          {!isHost && <FollowButton type="profile" id={e.host} following={Boolean(hostFollow.data)} onChange={() => hostFollow.reload()} label={e.profiles.display_name || e.profiles.username} />}
        </div>
        {org.data && (
          <div className="guide-row">
            <div className="grow"><span className="t-meta">Presented by</span><b><Link to={`/app/pages/${org.data.slug}`}>{org.data.name}</Link>{org.data.verified_at && <BadgeCheck size={16} aria-label="Verified by VYBE" style={{ marginLeft: 4, color: 'var(--brand)', verticalAlign: '-3px' }} />}</b></div>
            <FollowButton type="organization" id={org.data.id} following={Boolean(orgFollow.data)} onChange={() => orgFollow.reload()} label={org.data.name} />
          </div>
        )}
      </section>

      {e.description && <p style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>{e.description}</p>}
      <WhereCard e={e} />
      <LineupSection eventId={e.id} manage={canManage} />
      <LiveCard eventId={e.id} />
      <div id="tickets-anchor">{!cancelled && !isDraft && <TicketsSection e={e} manage={canManage} />}</div>
      {canManage && <section aria-labelledby="rq-h" style={{ marginBottom: 20 }}><h2 id="rq-h" className="t-section">Refund requests</h2><RefundQueue eventId={e.id} /></section>}

      {!cancelled && !isDraft && !isHost && (
        <section className="stack" style={{ gap: 8, marginBottom: 16 }} aria-labelledby="att-h">
          <h2 id="att-h" className="t-section">Are you going?</h2>
          {mineStatus === 'invited' && <p className="notice">You're invited. Will you come?</p>}
          <div className="row" role="group" aria-label="Your attendance" style={{ flexWrap: 'wrap' }}>
            {(['going', 'maybe', 'declined'] as Status[]).map(s => (
              <button key={s} className={`btn${mineStatus === s ? ' primary' : ''}`} aria-pressed={mineStatus === s} disabled={busy || (s === 'going' && full)} onClick={() => rsvp(s)}>
                {{ going: full ? 'Full' : 'Going', maybe: 'Interested', declined: "Can't go" }[s]}
              </button>
            ))}
          </div>
          {(mineStatus === 'going' || mineStatus === 'maybe') && (
            <label className="t-meta row" style={{ gap: 8, flexWrap: 'wrap' }}>Who can see this
              <select className="select" style={{ width: 'auto', minHeight: 36 }} value={mineVis} disabled={busy} onChange={x => setVisibility(x.target.value as Vis)} aria-label="Who can see that you are going">
                <option value="friends">Friends</option><option value="public">Everyone</option><option value="private">Only me and the host</option>
              </select>
            </label>
          )}
          <p className="t-meta">Going isn’t a ticket: if this plan sells tickets you still need one to get in.</p>
        </section>
      )}
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 24 }}>
        <button className="btn sm" onClick={share}><Share2 size={16} aria-hidden /> Share link</button>
        <ShareToFeed e={e} />
        {isHost && !cancelled && <><button className="btn sm" onClick={() => setInviting(true)}>Invite friends</button><button className="btn sm" onClick={() => setEditing(true)}>Edit</button><button className="btn sm danger" onClick={cancelPlan}>Cancel plan</button></>}
        {isHost && <button className="btn ghost sm danger" onClick={del}>Delete</button>}
        {!isHost && <button className="btn ghost sm" onClick={() => setReporting(true)}>Report</button>}
      </div>

      <h2 className="t-section">{goingCount} going{interestedCount ? ` · ${interestedCount} interested` : ''}</h2>
      {rsvps.loading ? <Spinner /> : going.length === 0 ? <p className="t-support" style={{ padding: '8px 0' }}>{goingCount > 0 ? 'People going keep their attendance private or share it only with friends.' : 'No one yet — be the first.'}</p> : (
        <>
          <div className="list">{going.map(r => <Link key={r.user_id} to={`/app/u/${r.profiles.username}`} className="item row link"><Avatar size="sm" path={r.profiles.avatar_path} name={r.profiles.display_name || r.profiles.username} /><span className="grow">{r.profiles.display_name || r.profiles.username}</span>{sc?.people.find(p => p.id === r.user_id)?.friend && <span className="t-meta">Friend</span>}</Link>)}</div>
          {goingCount > going.length && <p className="t-meta" style={{ marginTop: 8 }}>{goingCount - going.length} more {goingCount - going.length === 1 ? 'person keeps' : 'people keep'} their attendance private.</p>}
        </>
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
