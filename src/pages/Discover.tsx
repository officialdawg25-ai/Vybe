import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Collapse } from '../components/Collapse'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Check, ChevronDown, LocateFixed, MapPin, Search, Ticket, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { FriendButton } from '../components/FriendButton'
import { LocationPicker } from '../components/LocationPicker'
import { EventPoster } from '../components/discover/EventPoster'
import { DiscoverHero } from '../components/discover/DiscoverHero'
import { LiveList } from '../components/discover/LiveList'
import { OrgList, OrgRow } from '../components/discover/OrgList'
import { ResultsView, type Scope } from '../components/discover/ResultsView'
import { INTERESTS, loadRelations } from '../lib/friends'
import { rankByInterest, sharedInterests } from '../lib/feeds'
import { discoverEvents, discoverLive, discoverOrgs, rangeBounds, type DiscoverEvent } from '../lib/discover'
import { locateMe, usePlace } from '../lib/location'
import { useAsync, useSubmit } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { Avatar, Empty, ErrorState, Popover, Spinner, errMsg, toast } from '../ui'
import type { Community, PublicProfile } from '../lib/types'

export { rangeBounds }
type Person = PublicProfile & { interests: string[]; bio: string }
type Mode = 'foryou' | 'concerts' | 'events' | 'artists' | 'communities' | 'live'
const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: 'foryou', label: 'For you', blurb: 'Plans, artists and people picked from what you follow and where you are' },
  { id: 'concerts', label: 'Concerts & shows', blurb: 'Gigs, festivals, comedy, theatre and open mics' },
  { id: 'events', label: 'Events', blurb: 'Everything happening, from workshops to nightlife' },
  { id: 'artists', label: 'Artists & venues', blurb: 'Follow the artists, venues and organisers behind the plans' },
  { id: 'communities', label: 'Communities', blurb: 'Groups around music, campuses, places and shared interests' },
  { id: 'live', label: 'Live events', blurb: 'Broadcasts from concerts, festivals and community events' },
]
const RADII = [10, 25, 50, 100, 250]

/**
 * Discover: music, concerts, events, artists, communities and event broadcasts around a place you choose.
 * Home stays the social feed; individual live streams stay on Home/Live. Order is by time or distance, never by engagement,
 * and every number shown comes from the database (no invented attendance or popularity).
 */
export default function Discover() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const legacyTopic = params.get('topic')
  const mode: Mode = (MODES.find(m => m.id === params.get('mode'))?.id) ?? (legacyTopic === 'Music' ? 'concerts' : 'foryou')
  const topic = INTERESTS.includes(legacyTopic ?? '') && legacyTopic !== 'Music' ? legacyTopic! : ''
  const [place, setPlace] = usePlace(profile)
  const [scopeKind, setScopeKind] = useState<'all' | 'place'>(() => { try { return sessionStorage.getItem('vybe:discover-scope') === 'all' ? 'all' : 'place' } catch { return 'place' } })
  const [radius, setRadius] = useState(50)
  const [picking, setPicking] = useState(false)
  const [locating, setLocating] = useState(false)
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [dq, setDq] = useState('')
  useEffect(() => { document.title = 'Discover · VYBE' }, [])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim().length >= 2 ? q.trim() : ''), 300); return () => clearTimeout(t) }, [q])
  const setScope = (k: 'all' | 'place') => { setScopeKind(k); try { sessionStorage.setItem('vybe:discover-scope', k) } catch { /* ignore */ } }
  const scope: Scope = scopeKind === 'all' ? { label: 'all locations' } : { lat: place.lat, lng: place.lng, radiusKm: radius, label: place.name.replace(/^Near /, '') }
  const setMode = (m: Mode) => setParams(m === 'foryou' ? {} : { mode: m }, { replace: true })
  const cur = MODES.find(m => m.id === mode)!

  const nearMe = async () => {
    setLocating(true)
    try { setPlace(await locateMe()); setScope('place') } catch (e) { toast(errMsg(e)) } finally { setLocating(false) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (mode === 'foryou' && q.trim().length >= 2) nav(`/app/search?q=${encodeURIComponent(q.trim())}`) }

  return (
    <div className="cols">
      <div className="col-main discover shz">
        <header className="shz-head">
          <div className="row between">
            <h1 className="t-display-sm">Discover</h1>
            <button className="icon-btn" aria-label={searching ? 'Close search' : 'Search'} aria-expanded={searching} onClick={() => { setSearching(s => !s); if (searching) setQ('') }}>{searching ? <X size={22} /> : <Search size={22} />}</button>
          </div>
          <DiscoverHero />
          {searching && (
            <form role="search" aria-label="Search Discover" onSubmit={submit} className="row discover-search">
              <Search size={20} aria-hidden />
              <input className="input" type="search" autoFocus aria-label="Search" placeholder={mode === 'artists' ? 'Search artists, venues, organisers' : mode === 'communities' ? 'Search communities' : mode === 'foryou' ? 'Search plans, people, communities' : 'Search artists, events, venues, towns'} value={q} onChange={e => setQ(e.target.value)} />
            </form>
          )}
          <div className="shz-explore">
            <span className="shz-explore-label">Explore:</span>
            <Popover label="Choose what to explore" className="shz-pop" trigger={<span className="shz-mode">{cur.label}<ChevronDown size={22} aria-hidden /></span>}>
              {MODES.map(m => (
                <button key={m.id} role="menuitem" className="pop-item shz-item" onClick={() => setMode(m.id)}>
                  <span className="grow"><b>{m.label}</b></span>{m.id === mode && <Check size={16} aria-hidden />}
                </button>
              ))}
            </Popover>
          </div>
          <p className="shz-blurb">{cur.blurb}</p>
          {mode !== 'communities' && mode !== 'live' && (
            <div className="shz-loc" role="group" aria-label="Location">
              <button className="chip big" aria-pressed={scopeKind === 'all'} onClick={() => setScope('all')}><MapPin size={16} aria-hidden /> All locations</button>
              <button className="chip big" aria-pressed={scopeKind === 'place'} onClick={() => { if (scopeKind === 'place') setPicking(true); else setScope('place') }}>
                {scopeKind === 'place' ? <>{place.name.replace(/^Near /, '')} <ChevronDown size={14} aria-hidden /></> : 'A place…'}
              </button>
              <button className="chip big" disabled={locating} onClick={nearMe}><LocateFixed size={16} aria-hidden /> {locating ? 'Locating…' : 'Near me'}</button>
              {scopeKind === 'place' && (
                <label className="t-meta row" style={{ gap: 6 }}>Within
                  <select className="select" style={{ width: 'auto', minHeight: 36 }} value={radius} onChange={e => setRadius(Number(e.target.value))} aria-label="Search radius">{RADII.map(r => <option key={r} value={r}>{r} km</option>)}</select>
                </label>
              )}
            </div>
          )}
        </header>

        {mode === 'foryou' && <ForYou scope={scope} topic={topic} placeName={scope.label} setMode={setMode} />}
        {mode === 'concerts' && <ResultsView group="concerts" q={dq} scope={scope} />}
        {mode === 'events' && <ResultsView group="events" q={dq} scope={scope} />}
        {mode === 'artists' && <OrgList q={dq} />}
        {mode === 'communities' && <CommunityBrowse q={dq} topic={topic} />}
        {mode === 'live' && <LiveList />}
      </div>
      <aside className="col-side" aria-label="Shortcuts">
        <section className="card" aria-labelledby="d-mine">
          <h2 id="d-mine" className="t-section" style={{ marginBottom: 4 }}>Your tickets</h2>
          <p className="t-meta" style={{ marginBottom: 8 }}>QR codes for events you’re going to.</p>
          <Link className="btn sm" to="/app/tickets"><Ticket size={16} aria-hidden /> Open my tickets</Link>
        </section>
        <section className="card" aria-labelledby="d-host">
          <h2 id="d-host" className="t-section" style={{ marginBottom: 4 }}>Host something</h2>
          <p className="t-meta" style={{ marginBottom: 8 }}>Gigs, open mics, meet-ups: publish a plan and let people find it.</p>
          <Link className="btn sm primary" to="/app/plans?new=1">Create an event</Link>
        </section>
      </aside>
      {picking && <LocationPicker title="Explore a place" onPick={p => { setPlace(p); setScope('place') }} onClose={() => setPicking(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ For you */
function Rail({ title, to, children }: { title: string; to?: () => void; children: React.ReactNode }) {
  return (
    <section className="d-sec" aria-label={title}>
      <div className="row between"><h2 className="t-section">{title}</h2>{to && <button className="linklike t-meta" onClick={to}>See all</button>}</div>
      <ul className="hscroll poster-rail">{children}</ul>
    </section>
  )
}

function ForYou({ scope, topic, placeName, setMode }: { scope: Scope; topic: string; placeName: string; setMode: (m: Mode) => void }) {
  const { uid, profile } = useAuth()
  const mine = profile?.interests ?? []
  const key = JSON.stringify(scope)
  const data = useAsync(async () => {
    const base = { ...rangeBounds('any'), lat: scope.lat, lng: scope.lng, radiusKm: scope.radiusKm, limit: 10 }
    const [followed, friends, soon, live, orgs] = await Promise.all([
      discoverEvents({ ...base, followed: true }), discoverEvents({ ...base, friends: true }), discoverEvents({ ...base }),
      discoverLive().catch(() => null), discoverOrgs({ limit: 8 }).catch(() => null),
    ])
    return { followed, friends, soon, live, orgs, upgraded: soon !== null }
  }, [key])

  const circle = useAsync(async () => {
    const [rels, mem] = await Promise.all([loadRelations(uid!), supabase.from('community_members').select('community_id').eq('user_id', uid!)])
    if (mem.error) throw mem.error
    return { rels, joined: new Set((mem.data ?? []).map(r => r.community_id)) }
  }, [uid])
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
    if (topic) query = query.contains('interests', [topic]); else if (mine.length) query = query.overlaps('interests', mine)
    const { data, error } = await query
    if (error) throw error
    return rankByInterest(((data ?? []) as Person[]).filter(p => !circle.data!.rels.has(p.id)), topic ? [topic] : mine, p => p.interests).slice(0, 8)
  }, [uid, topic, circle.data])

  if (data.loading && !data.data) return <Spinner />
  if (data.error) return <ErrorState message={data.error} onRetry={data.reload} />
  const d = data.data!
  if (!d.upgraded) return <p className="notice" role="status">Discover is being upgraded on this server. In the meantime, <Link to="/app/plans" style={{ textDecoration: 'underline' }}>browse plans</Link>.</p>
  const nothing = !d.soon?.length && !d.followed?.length && !d.friends?.length
  const seen = new Set<string>()
  const fresh = (rows: DiscoverEvent[] | null | undefined) => (rows ?? []).filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
  const followedRows = fresh(d.followed), friendRows = fresh(d.friends), soonRows = fresh(d.soon)

  return (
    <>
      {d.live?.some(s => s.status === 'live') && (
        <section className="d-sec" aria-label="Live now">
          <div className="row between"><h2 className="t-section">Live from events</h2><button className="linklike t-meta" onClick={() => setMode('live')}>See all</button></div>
          <ul className="hscroll poster-rail">{d.live.filter(s => s.status === 'live').slice(0, 6).map(s => (
            <li key={s.id}><Link to={s.can_watch ? `/app/live/${s.id}` : `/app/plans/${s.event.id}`} className="poster rail"><div className="poster-art"><span className="pill-live">LIVE</span><span className="poster-initial" aria-hidden>{s.event.title.charAt(0)}</span></div><span className="poster-title clamp-2">{s.title}</span><span className="t-meta clamp-1">{s.event.title}</span></Link></li>
          ))}</ul>
        </section>
      )}
      {followedRows.length > 0 && <Rail title="From people and pages you follow" to={() => setMode('concerts')}>{followedRows.map(e => <li key={e.id}><EventPoster e={e} rail /></li>)}</Rail>}
      {friendRows.length > 0 && <Rail title="Your friends are going">{friendRows.map(e => <li key={e.id}><EventPoster e={e} rail /></li>)}</Rail>}
      {soonRows.length > 0
        ? <Rail title={scope.lat != null ? `Coming up near ${placeName}` : 'Coming up'} to={() => setMode('events')}>{soonRows.map(e => <li key={e.id}><EventPoster e={e} rail /></li>)}</Rail>
        : nothing && (
          <Empty title={scope.lat != null ? `No plans within ${scope.radiusKm} km of ${placeName}` : 'No plans yet'} action={<div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}><button className="btn" onClick={() => setMode('artists')}>Follow artists and venues</button><Link className="btn primary" to="/app/plans?new=1">Host the first one</Link></div>}>
            Try All locations, a nearby town or a wider radius. VYBE shows only real plans, so a quiet area stays quiet until someone hosts.
          </Empty>
        )}
      {d.orgs && d.orgs.length > 0 && (
        <section className="d-sec" aria-label="Artists and venues">
          <div className="row between"><h2 className="t-section">Artists, venues and organisers</h2><button className="linklike t-meta" onClick={() => setMode('artists')}>See all</button></div>
          <ul className="org-list">{d.orgs.slice(0, 4).map(o => <OrgRow key={o.id} o={o} />)}</ul>
        </section>
      )}
      {(communities.data?.length ?? 0) > 0 && (
        <section aria-labelledby="d-comms" className="d-sec">
          <div className="row between"><h2 id="d-comms" className="t-section">Communities to join</h2><button className="linklike t-meta" onClick={() => setMode('communities')}>See all</button></div>
          <div className="d-grid">{communities.data!.map(c => <CommunityCard key={c.id} c={c} mine={topic ? [topic] : mine} onJoined={circle.reload} />)}</div>
        </section>
      )}
      {(people.data?.length ?? 0) > 0 && (
        <section aria-labelledby="d-people" className="d-sec">
          <div className="row between"><h2 id="d-people" className="t-section">{mine.length ? 'People who share your interests' : 'People to meet'}</h2><Link to="/app/people" className="t-meta">See all</Link></div>
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
        </section>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ Communities */
function CommunityBrowse({ q, topic }: { q: string; topic: string }) {
  const { uid } = useAuth()
  const [t, setT] = useState(topic)
  const circle = useAsync(async () => {
    const { data, error } = await supabase.from('community_members').select('community_id').eq('user_id', uid!)
    if (error) throw error
    return new Set((data ?? []).map(r => r.community_id as string))
  }, [uid])
  const list = useAsync(async () => {
    let query = supabase.from('communities').select('*').eq('visibility', 'public').order('created_at', { ascending: false }).limit(48)
    if (t) query = query.contains('topics', [t])
    if (q) { const s = q.replace(/[%_,()]/g, ' '); query = query.or(`name.ilike.%${s}%,description.ilike.%${s}%`) }
    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as Community[]
  }, [q, t])
  const chips = useMemo(() => [...new Set([...(INTERESTS)])].slice(0, 15), [])
  return (
    <div>
      <div className="d-filters"><Collapse title="Topics" summary={t || 'All'} defaultOpen={Boolean(t)}><div className="chips" role="group" aria-label="Topic">{chips.map(c => <button key={c} className="chip" aria-pressed={t === c} onClick={() => setT(t === c ? '' : c)}>{c}</button>)}</div></Collapse></div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title="No communities found" action={<Link className="btn primary" to="/app/communities">Start a community</Link>}>Try another topic, or create the first community for it.</Empty>
      ) : <div className="d-grid">{list.data.map(c => <CommunityCard key={c.id} c={c} mine={t ? [t] : []} joined={circle.data?.has(c.id)} onJoined={circle.reload} />)}</div>}
    </div>
  )
}

function CommunityCard({ c, mine, onJoined, joined: already }: { c: Community; mine: string[]; onJoined: () => void; joined?: boolean }) {
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
        {joined || already ? <Link className="btn sm" to={`/app/communities/${c.id}`}>Joined · Open</Link> : <button className="btn primary sm" disabled={busy} onClick={join}>Join</button>}
        <Link className="btn ghost sm" to={`/app/communities/${c.id}`}>View</Link>
      </div>
    </article>
  )
}
