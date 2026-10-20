import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, MapPin, Search, Ticket, Users } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { FriendButton } from '../components/FriendButton'
import { LocationPicker } from '../components/LocationPicker'
import { INTERESTS, loadRelations } from '../lib/friends'
import { rankByInterest, sharedInterests } from '../lib/feeds'
import { distanceKm } from '../lib/cities'
import { usePlace } from '../lib/location'
import { isMissingSchema, money } from '../lib/tickets'
import { useAsync, useSubmit } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { formatEventTime } from '../lib/format'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../ui'
import type { Community, EventRow, PublicProfile } from '../lib/types'

type Person = PublicProfile & { interests: string[]; bio: string }
type Range = 'any' | 'today' | 'weekend' | 'week'
type EventCard = EventRow & { going?: { count: number }[]; ticket_types?: { price_cents: number; status: string }[]; event_lineup?: { name: string; role: string; sort: number }[] }

const RADII = [10, 25, 50, 100, 250]
const RANGES: { id: Range; label: string }[] = [{ id: 'any', label: 'Any time' }, { id: 'today', label: 'Today' }, { id: 'weekend', label: 'This weekend' }, { id: 'week', label: 'Next 7 days' }]

/** Resolves a date-range chip to [from, to] ISO bounds in the viewer's local time. */
export function rangeBounds(r: Range, now = new Date()): { from: string; to: string | null } {
  const start = new Date(now); start.setHours(0, 0, 0, 0)
  const day = (d: Date, add: number) => { const x = new Date(d); x.setDate(x.getDate() + add); return x }
  if (r === 'today') return { from: now.toISOString(), to: day(start, 1).toISOString() }
  if (r === 'week') return { from: now.toISOString(), to: day(start, 8).toISOString() }
  if (r === 'weekend') {
    const dow = start.getDay()                                   // 0 Sun … 6 Sat
    const sat = dow === 0 ? day(start, -1) : day(start, 6 - dow)  // Sunday: the weekend is already running
    return { from: new Date(Math.max(now.getTime(), sat.getTime())).toISOString(), to: day(sat, 2).toISOString() }
  }
  return { from: now.toISOString(), to: null }
}

/**
 * Discover: what is happening around a place you choose. Plans come from the events_near() function (public events only,
 * filtered by Row Level Security), then people and communities beyond your circle. Nothing is "trending": order is by
 * start time or distance, and the reasons are shown.
 */
export default function Discover() {
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const topic = INTERESTS.includes(params.get('topic') ?? '') ? params.get('topic')! : ''
  const [place, setPlace] = usePlace(profile)
  const [picking, setPicking] = useState(false)
  const [radius, setRadius] = useState(50)
  const [range, setRange] = useState<Range>('any')
  const [sort, setSort] = useState<'soonest' | 'nearest'>('soonest')
  const [q, setQ] = useState('')
  useEffect(() => { document.title = 'Discover · VYBE' }, [])
  const mine = profile?.interests ?? []
  const chips = useMemo(() => [...new Set([...mine, ...INTERESTS])].slice(0, 15), [mine])

  const circle = useAsync(async () => {
    const [rels, mem] = await Promise.all([loadRelations(uid!), supabase.from('community_members').select('community_id').eq('user_id', uid!)])
    if (mem.error) throw mem.error
    return { rels, joined: new Set((mem.data ?? []).map(r => r.community_id)) }
  }, [uid])

  const events = useAsync(async () => {
    const { from, to } = rangeBounds(range)
    const near = await supabase.rpc('events_near', { p_lat: place.lat, p_lng: place.lng, p_radius_km: radius, p_from: from, p_to: to, p_q: topic || q.trim() || null })
    let ids: string[] = []
    if (near.error) {
      if (!isMissingSchema(near.error)) throw near.error
      // Database not upgraded yet: fall back to the plain list of upcoming public plans (no distance).
      const old = await supabase.from('events').select('*, profiles:host(id,username,display_name,avatar_path)').eq('status', 'active').eq('visibility', 'public').neq('host', uid!).gte('starts_at', from).order('starts_at').limit(20)
      if (old.error) throw old.error
      return { rows: (old.data ?? []) as unknown as EventCard[], upgraded: false }
    }
    ids = ((near.data ?? []) as EventRow[]).map(e => e.id)
    if (!ids.length) return { rows: [] as EventCard[], upgraded: true }
    const full = await supabase.from('events')
      .select('*, profiles:host(id,username,display_name,avatar_path), going:event_rsvps(count), ticket_types(price_cents,status), event_lineup(name,role,sort)')
      .in('id', ids).eq('going.status', 'going')
    if (full.error) throw full.error
    return { rows: (full.data ?? []) as unknown as EventCard[], upgraded: true }
  }, [place.lat, place.lng, radius, range, topic, q, uid])

  const shown = useMemo(() => {
    const rows = [...(events.data?.rows ?? [])]
    const d = (e: EventCard) => (e.lat != null && e.lng != null ? distanceKm(place, { lat: e.lat, lng: e.lng }) : Infinity)
    rows.sort(sort === 'nearest' ? (a, b) => d(a) - d(b) : (a, b) => a.starts_at.localeCompare(b.starts_at))
    return rows.map(e => ({ e, km: d(e) }))
  }, [events.data, place, sort])

  const communities = useAsync(async () => {
    if (!circle.data) return [] as Community[]
    let query = supabase.from('communities').select('*').eq('visibility', 'public').order('created_at', { ascending: false }).limit(40)
    if (topic) query = query.contains('topics', [topic])
    const { data, error } = await query
    if (error) throw error
    return rankByInterest(((data ?? []) as Community[]).filter(c => !circle.data!.joined.has(c.id)), topic ? [topic] : mine, c => c.topics).slice(0, 4)
  }, [uid, topic, circle.data])

  const people = useAsync(async () => {
    if (!circle.data) return [] as Person[]
    let query = supabase.from('profiles').select('id,username,display_name,avatar_path,interests,bio').neq('id', uid!).limit(60)
    if (topic) query = query.contains('interests', [topic])
    else if (mine.length) query = query.overlaps('interests', mine)
    const { data, error } = await query
    if (error) throw error
    const strangers = ((data ?? []) as Person[]).filter(p => !circle.data!.rels.has(p.id))
    return rankByInterest(strangers, topic ? [topic] : mine, p => p.interests).slice(0, 8)
  }, [uid, topic, circle.data])

  const submit = (e: FormEvent) => { e.preventDefault(); const v = q.trim(); if (v.length >= 2) nav(`/app/search?q=${encodeURIComponent(v)}`) }
  const setTopic = (t: string) => setParams(t && t !== topic ? { topic: t } : {}, { replace: true })

  const interestChips = (
    <div className="chips" role="group" aria-label="Filter by interest">
      {chips.map(c => <button key={c} className="chip" aria-pressed={topic === c} onClick={() => setTopic(c)}>{c}</button>)}
    </div>
  )

  return (
    <div className="cols">
      <div className="col-main discover">
        <header className="discover-head">
          <h1 className="t-display-sm">Discover</h1>
          <button className="place-btn" onClick={() => setPicking(true)} aria-haspopup="dialog">
            <MapPin size={18} aria-hidden /><span className="grow"><span className="t-meta" style={{ display: 'block' }}>Exploring</span><b>{place.name}{place.country ? `, ${place.country}` : ''}</b></span><ChevronDown size={18} aria-hidden />
          </button>
          <form role="search" aria-label="Search plans" onSubmit={submit} className="row discover-search">
            <Search size={20} aria-hidden />
            <input className="input" type="search" aria-label="Search plans by name" placeholder="Search plans, people, communities" value={q} onChange={e => setQ(e.target.value)} />
            <button className="btn primary" style={{ flex: 'none' }}>Search</button>
          </form>
          <div className="filters">
            <div className="chips" role="group" aria-label="When">{RANGES.map(r => <button key={r.id} className="chip" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>)}</div>
            <label className="t-meta row" style={{ gap: 6 }}>Within
              <select className="select" style={{ width: 'auto', minHeight: 36 }} value={radius} onChange={e => setRadius(Number(e.target.value))} aria-label="Search radius">{RADII.map(r => <option key={r} value={r}>{r} km</option>)}</select></label>
            <label className="t-meta row" style={{ gap: 6 }}>Sort
              <select className="select" style={{ width: 'auto', minHeight: 36 }} value={sort} onChange={e => setSort(e.target.value as 'soonest' | 'nearest')} aria-label="Sort plans"><option value="soonest">Soonest</option><option value="nearest">Nearest</option></select></label>
          </div>
          <div className="d-chips-inline">{interestChips}</div>
        </header>

        <section aria-labelledby="d-plans" className="d-sec">
          <h2 id="d-plans" className="t-section">Plans near {place.name.replace(/^Near /, '')}{topic ? ` · ${topic}` : ''}</h2>
          {events.data && !events.data.upgraded && <p className="notice" role="status">Location search isn’t switched on for this app yet, so you’re seeing upcoming public plans everywhere.</p>}
          {events.loading && !events.data ? <Spinner /> : events.error ? <ErrorState message={events.error} onRetry={events.reload} /> : !shown.length ? (
            <Empty title={`No plans within ${radius} km`} action={<div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
              {radius < 250 && <button className="btn" onClick={() => setRadius(RADII[Math.min(RADII.length - 1, RADII.indexOf(radius) + 1)])}>Widen to {RADII[Math.min(RADII.length - 1, RADII.indexOf(radius) + 1)]} km</button>}
              <button className="btn" onClick={() => setPicking(true)}>Try another city</button><Link className="btn primary" to="/app/plans">Host the first one</Link></div>}>
              {topic || q ? 'Try clearing the filters.' : 'Be the first to host something here.'}
            </Empty>
          ) : (
            <div className="ev-list">{shown.map(({ e, km }, i) => <EventTile key={e.id} e={e} km={km} feature={i === 0 && sort === 'soonest'} />)}</div>
          )}
        </section>

        {(communities.loading || communities.error || communities.data?.length) ? (
          <section aria-labelledby="d-comms" className="d-sec">
            <div className="row between"><h2 id="d-comms" className="t-section">Communities to join</h2><Link to="/app/communities" className="t-meta">Browse all</Link></div>
            {communities.loading ? <Spinner /> : communities.error ? <ErrorState message={communities.error} onRetry={communities.reload} /> : (
              <div className="d-grid">{communities.data!.map(c => <CommunityCard key={c.id} c={c} mine={topic ? [topic] : mine} onJoined={circle.reload} />)}</div>
            )}
          </section>
        ) : null}

        {(people.loading || people.error || people.data?.length) ? (
          <section aria-labelledby="d-people" className="d-sec">
            <div className="row between"><h2 id="d-people" className="t-section">{topic ? `People into ${topic}` : mine.length ? 'People who share your interests' : 'People to meet'}</h2><Link to="/app/friends" className="t-meta">Friends</Link></div>
            {people.loading ? <Spinner /> : people.error ? <ErrorState message={people.error} onRetry={people.reload} /> : (
              <ul className="hscroll people" aria-label="Suggested people">
                {people.data!.map(p => (
                  <li key={p.id} className="person">
                    <Link to={`/app/u/${p.username}`} className="person-link"><Avatar path={p.avatar_path} name={p.display_name || p.username} size="lg" />
                      <span className="t-name clamp-1">{p.display_name || p.username}</span>
                      <span className="t-meta clamp-1">{sharedInterests(topic ? [topic] : mine, p.interests).slice(0, 2).join(' · ') || `@${p.username}`}</span>
                    </Link>
                    <FriendButton other={p.id} rel={circle.data?.rels.get(p.id)} onChanged={circle.reload} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
      <aside className="col-side" aria-label="Browse by interest">
        <section className="card" aria-labelledby="d-int">
          <h2 id="d-int" className="t-section" style={{ marginBottom: 8 }}>Browse by interest</h2>
          {interestChips}
          {topic && <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setTopic('')}>Clear filter</button>}
        </section>
        <section className="card" aria-labelledby="d-mine">
          <h2 id="d-mine" className="t-section" style={{ marginBottom: 4 }}>Your tickets</h2>
          <p className="t-meta" style={{ marginBottom: 8 }}>QR codes for events you’re going to.</p>
          <Link className="btn sm" to="/app/tickets"><Ticket size={16} aria-hidden /> Open my tickets</Link>
        </section>
      </aside>
      {picking && <LocationPicker title="Explore a place" onPick={setPlace} onClose={() => setPicking(false)} />}
    </div>
  )
}

function EventTile({ e, km, feature }: { e: EventCard; km: number; feature: boolean }) {
  const cover = useSigned(e.cover_path)
  const d = new Date(e.starts_at)
  const month = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: e.timezone }).format(d)
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: e.timezone }).format(d)
  const prices = (e.ticket_types ?? []).filter(t => t.status === 'active').map(t => t.price_cents)
  const from = prices.length ? Math.min(...prices) : e.price_cents
  const going = e.going?.[0]?.count ?? 0
  const acts = [...(e.event_lineup ?? [])].sort((a, b) => a.sort - b.sort).slice(0, 3).map(a => a.name)
  return (
    <Link to={`/app/plans/${e.id}`} className={`ev-tile${feature ? ' feature' : ''}`}>
      <div className="ev-cover" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        <span className="plan-date" aria-hidden><span>{month}</span><b>{day}</b></span>
      </div>
      <div className="ev-body">
        <span className="t-name ev-title">{e.title}</span>
        <span className="t-meta clamp-1">{formatEventTime(e.starts_at, e.timezone)}</span>
        <span className="t-meta clamp-1"><MapPin size={12} aria-hidden /> {[e.venue, e.city].filter(Boolean).join(', ') || e.location || 'Location to be announced'}{Number.isFinite(km) ? ` · ${km < 1 ? '<1' : Math.round(km)} km` : ''}</span>
        {acts.length > 0 && <span className="t-meta clamp-1">Featuring {acts.join(', ')}</span>}
        <span className="ev-foot"><span className="t-meta"><Users size={12} aria-hidden /> {going} going</span><b>{from == null ? 'See details' : from === 0 ? 'Free' : `From ${money(from)}`}</b></span>
      </div>
    </Link>
  )
}

function CommunityCard({ c, mine, onJoined }: { c: Community; mine: string[]; onJoined: () => void }) {
  const { uid } = useAuth()
  const [busy, submit] = useSubmit()
  const [joined, setJoined] = useState(false)
  const join = () => submit(async () => {
    const { error } = await supabase.from('community_members').insert({ community_id: c.id, user_id: uid })
    if (error && error.code !== '23505') return toast(errMsg(error))
    setJoined(true); toast(`Joined ${c.name}`); onJoined()
  })
  const shared = sharedInterests(mine, c.topics)
  return (
    <article className="d-card">
      <Link to={`/app/communities/${c.id}`} className="t-name">{c.name}</Link>
      <p className="t-support clamp-2">{c.description || 'A public community on VYBE.'}</p>
      {c.topics.length > 0 && <div className="chips" aria-label="Topics">{c.topics.slice(0, 3).map(t => <span key={t} className={`chip static${shared.includes(t) ? ' on' : ''}`}>{t}</span>)}</div>}
      <div className="row" style={{ marginTop: 'auto' }}>
        {joined ? <Link className="btn sm" to={`/app/communities/${c.id}`}>Joined · Open</Link> : <button className="btn primary sm" disabled={busy} onClick={join}>Join</button>}
        <Link className="btn ghost sm" to={`/app/communities/${c.id}`}>View</Link>
      </div>
    </article>
  )
}
