import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Collapse } from '../components/Collapse'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Flame, LocateFixed, MapPin, Radio, Search, Ticket } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { FriendButton } from '../components/FriendButton'
import { CategoryRail, type Tile } from '../components/discover/CategoryRail'
// The banner is part of the page's first render (it is the largest thing on screen); its data is requested as the page
// starts (prefetchBillboard), so it fills in moments later instead of after a second download.
import { DiscoverHero } from '../components/HomeBillboard'
import { EventPoster } from '../components/discover/EventPoster'
import { ResultsView, type Scope } from '../components/discover/ResultsView'
import { LocationControl, useDiscoverScope } from '../components/discover/Scope'
import { INTERESTS, loadRelations } from '../lib/friends'
import { rankByInterest, sharedInterests } from '../lib/feeds'
import { discoverEvents, discoverLive, discoverOrgs, rangeBounds, shortDate, useCategories, type DiscoverEvent } from '../lib/discover'
import { buildTiles, useTileMedia } from '../lib/tiles'
import { isMissingSchema } from '../lib/tickets'
import { prefetchBillboard } from '../lib/promos'
import { useAsync, useSubmit } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../ui'
import { OrgRail, OrgTile } from '../components/discover/OrgRail'
import type { Community, PublicProfile } from '../lib/types'

export { rangeBounds }
type Person = PublicProfile & { interests: string[]; bio: string }
type Filter = 'foryou' | 'nearby' | 'trending' | 'following'
const FILTERS: { id: Filter; label: string }[] = [{ id: 'foryou', label: 'For you' }, { id: 'nearby', label: 'Nearby' }, { id: 'trending', label: 'Trending' }, { id: 'following', label: 'Following' }]
const ARTISTS = ['artist', 'creator'], VENUES = ['venue'], ORGANISERS = ['organizer', 'business', 'brand']
// Old links (?cat=… or ?mode=…) open the matching category screen.
const LEGACY: Record<string, string> = { concerts: 'music', events: 'things', artists: 'artists', communities: 'communities', live: 'live' }

/**
 * Discover: what's on around a place you choose. The top of the page is the banner, search, place and the four ways of
 * looking (For you, Nearby, Trending, Following); below it, a slowly gliding row of category tiles, each opening that
 * category's own clean screen (nothing is pre-selected or opened in place). Every number shown comes from the database.
 */
export default function Discover() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const legacyTopic = params.get('topic')
  const cats = useCategories()
  const media = useTileMedia()
  const filter: Filter = FILTERS.find(f => f.id === params.get('f'))?.id ?? 'foryou'
  const topic = INTERESTS.includes(legacyTopic ?? '') && legacyTopic !== 'Music' ? legacyTopic! : ''
  const s = useDiscoverScope(profile)
  const { scope, place } = s
  // The banner's data starts loading with the page, in parallel with the banner's own code (see prefetchBillboard).
  useState(() => { if (!params.get('cat') && !params.get('mode') && !params.get('f')) prefetchBillboard(place, 'discover') })
  const [q, setQ] = useState('')
  useEffect(() => { document.title = 'Discover · VYBE' }, [])
  const setF = (f: Filter) => setParams(f === 'foryou' ? {} : { f }, { replace: true })
  const open = (id: string) => nav(`/app/discover/c/${LEGACY[id] ?? id}`)

  // One request gives every tile without an admin-chosen cover a real one: the first upcoming plan with artwork in that category.
  const art = useAsync(async () => (await discoverEvents({ ...rangeBounds('any'), lat: scope.lat, lng: scope.lng, radiusKm: scope.radiusKm, limit: 60 }).catch(() => null)) ?? [], [JSON.stringify(scope)])
  const tiles = useMemo<Tile[]>(() => {
    const rows = (art.data ?? []).filter(e => e.cover_path)
    const groupOf = new Map(cats.map(c => [c.slug, c.group_key]))
    const cover = (id: string) => rows.find(e => id === 'music' ? groupOf.get(e.category ?? '') === 'concerts' : id === 'things' ? true : id === 'online' ? e.format === 'online' : e.category === id)?.cover_path ?? null
    return buildTiles(cats).map(t => ({ id: t.id, label: t.label, icon: t.icon, accent: t.accent, media: media.get(t.id) ?? null, art: t.kind === 'events' ? cover(t.id) : null }))
  }, [cats, art.data, media])

  const legacy = params.get('cat') ?? LEGACY[params.get('mode') ?? ''] ?? (legacyTopic === 'Music' ? 'music' : null)
  if (legacy && legacy !== 'all') return <Navigate to={`/app/discover/c/${legacy}`} replace />

  const submit = (e: FormEvent) => { e.preventDefault(); if (q.trim().length >= 2) nav(`/app/search?q=${encodeURIComponent(q.trim())}`) }

  let body: React.ReactNode
  if (filter === 'nearby' && scope.lat == null) body = <NeedPlace onPick={() => s.setKind('place')} onNearMe={s.nearMe} locating={s.locating} />
  else if (filter === 'nearby') body = <ResultsView key="nearby" group="events" q="" scope={scope} preset={{ sort: 'nearest' }} title={`Near ${scope.label}`} />
  else if (filter === 'trending') body = <TrendingView scope={scope} />
  else if (filter === 'following') body = <FollowingView scope={scope} />
  else body = <ForYou scope={scope} topic={topic} placeName={scope.label} setMode={open} />

  return (
    <div className="cols">
      <div className="col-main discover shz">
        {filter === 'foryou' && <DiscoverHero place={place} />}
        <header className="shz-head">
          <h1 className="t-display-sm">Discover</h1>
          <form role="search" aria-label="Search Discover" onSubmit={submit} className="dsearch">
            <Search size={20} aria-hidden />
            <input type="search" aria-label="Search" placeholder="Search events, artists, venues, towns" value={q} onChange={e => setQ(e.target.value)} />
          </form>
          <LocationControl s={s} />
          <div className="dfilters" role="tablist" aria-label="Show">
            {FILTERS.map(f => <button key={f.id} role="tab" type="button" className="dfilter" aria-selected={filter === f.id} onClick={() => setF(f.id)}>{f.id === 'trending' && <Flame size={14} aria-hidden />}{f.label}</button>)}
          </div>
        </header>
        <CategoryRail tiles={tiles} />
        <h2 className="sr-only" aria-live="polite">{FILTERS.find(f => f.id === filter)!.label}</h2>
        {body}
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
    </div>
  )
}

export function NeedPlace({ onPick, onNearMe, locating }: { onPick: () => void; onNearMe: () => void; locating: boolean }) {
  return (
    <Empty title="Nearby needs a place" action={<div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}><button className="btn" onClick={onPick}>Choose a place</button><button className="btn primary" disabled={locating} onClick={onNearMe}><LocateFixed size={16} aria-hidden /> {locating ? 'Locating…' : 'Use my location'}</button></div>}>
      You’re browsing all locations. Pick a town or use your location to see what’s closest first.
    </Empty>
  )
}

/* ------------------------------------------------------------------ Trending */
interface Trend { id: string; title: string; starts_at: string; timezone: string; city: string | null; venue: string | null; cover_path: string | null; going: number; price_from_cents: number | null; trending: boolean }

/** Ranked by the documented server score (recent ticket sales and new "going", plus total going and starting soon). The list is
 *  padded with the soonest plans when little is happening; only the ones with real recent activity carry the Trending label. */
function TrendingView({ scope }: { scope: Scope }) {
  const list = useAsync(async () => {
    const { data, error } = await supabase.rpc('trending_events', { p_lat: scope.lat ?? null, p_lng: scope.lng ?? null, p_radius_km: scope.radiusKm ?? 100, p_limit: 20 })
    if (error) { if (isMissingSchema(error)) return null; throw error }
    return (Array.isArray(data) ? data : []) as Trend[]
  }, [JSON.stringify(scope)])
  if (list.loading && !list.data) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (list.data === null) return <p className="notice" role="status">Trending needs the latest database update.</p>
  if (!list.data.length) return <Empty title={scope.lat != null ? `Nothing coming up near ${scope.label}` : 'Nothing coming up yet'} action={<Link className="btn primary" to="/app/plans?new=1">Host something</Link>}>Try All locations or a wider radius.</Empty>
  const hot = list.data.filter(t => t.trending).length
  return (
    <>
      <p className="d-note">{hot ? `${hot} ${hot === 1 ? 'plan is' : 'plans are'} picking up: ranked by tickets sold and people saying they’re going in the last 7 days.` : 'Nothing is picking up this week yet, so these are the soonest plans.'}</p>
      <ol className="poster-grid" style={{ listStyle: 'none', padding: 0 }}>{list.data.map(t => <li key={t.id}><TrendPoster t={t} /></li>)}</ol>
    </>
  )
}

function TrendPoster({ t }: { t: Trend }) {
  const cover = useSigned(t.cover_path)
  const at = new Date(t.starts_at)
  return (
    <Link to={`/app/plans/${t.id}`} className="poster" aria-label={`${t.title}, ${shortDate(t.starts_at, t.timezone)}`}>
      <div className="poster-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {!cover && <span className="poster-initial" aria-hidden>{t.title.charAt(0).toUpperCase()}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="poster-date" aria-hidden><b>{new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: t.timezone }).format(at)}</b><span>{new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: t.timezone }).format(at)}</span></span>
        {t.trending && <span className="pill-live"><Flame size={12} aria-hidden /> Trending</span>}
        <span className="poster-over">
          <span className="poster-title clamp-2">{t.title}</span>
          <span className="poster-line clamp-1"><MapPin size={12} aria-hidden /> {[t.venue, t.city].filter(Boolean).join(', ') || 'Location to be announced'}</span>
          {t.going > 0 && <span className="poster-foot"><b>{t.going} going</b></span>}
        </span>
      </div>
    </Link>
  )
}

function LiveTile({ s }: { s: { id: string; title: string; can_watch: boolean; viewers: number | null; host: string | null; org: string | null; event: { id: string; title: string; cover_path: string | null } } }) {
  const cover = useSigned(s.event.cover_path)
  return (
    <Link to={s.can_watch ? `/app/live/${s.id}` : `/app/plans/${s.event.id}`} className="poster rail" aria-label={`Live: ${s.title}`}>
      <div className="poster-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {!cover && <span className="poster-initial" aria-hidden>{s.event.title.charAt(0)}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="pill-live"><Radio size={12} aria-hidden /> LIVE</span>
        <span className="poster-over">
          <span className="poster-title clamp-2">{s.title}</span>
          <span className="poster-line clamp-1">{s.event.title}</span>
          {(s.org || s.host) && <span className="poster-by clamp-1">by {s.org ?? s.host}</span>}
          {s.viewers != null && <span className="poster-foot">{s.viewers} watching</span>}
        </span>
      </div>
    </Link>
  )
}

/* ------------------------------------------------------------------ Following */
function FollowingView({ scope }: { scope: Scope }) {
  const orgs = useAsync(() => discoverOrgs({ followed: true, limit: 12 }), [])
  return (
    <>
      {(orgs.data?.length ?? 0) > 0 && (
        <section className="d-sec" aria-label="Pages you follow">
          <h2 className="t-section">Pages you follow</h2>
          <ul className="hscroll org-rail">{orgs.data!.map(o => <li key={o.id}><OrgTile o={o} /></li>)}</ul>
        </section>
      )}
      <ResultsView group="events" q="" scope={scope} preset={{ followed: true }} title="From pages you follow" />
    </>
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

function ForYou({ scope, topic, placeName, setMode }: { scope: Scope; topic: string; placeName: string; setMode: (m: string) => void }) {
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
            <li key={s.id}><LiveTile s={s} /></li>
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
      {/* One rail per kind of page: who is behind the plans, each card on its own artwork. */}
      <OrgRail title="Artists" kinds={ARTISTS} seeAll={() => setMode('artists')} />
      <OrgRail title="Venues" kinds={VENUES} seeAll={() => setMode('artists')} />
      <OrgRail title="Organisers" kinds={ORGANISERS} seeAll={() => setMode('artists')} />
      {(communities.data?.length ?? 0) > 0 && (
        <section aria-labelledby="d-comms" className="d-sec">
          <div className="row between"><h2 id="d-comms" className="t-section">Communities to join</h2><button className="linklike t-meta" onClick={() => setMode('communities')}>See all</button></div>
          <ul className="hscroll org-rail">{communities.data!.map(c => <li key={c.id}><CommunityCard c={c} mine={topic ? [topic] : mine} onJoined={circle.reload} /></li>)}</ul>
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
export function CommunityBrowse({ q, topic }: { q: string; topic: string }) {
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
  const cover = useSigned(c.cover_path)
  return (
    <article className="org-tile">
      <Link to={`/app/communities/${c.id}`} className="org-tile-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-label={c.name}>
        {!cover && <span className="poster-initial" aria-hidden>{c.name.charAt(0).toUpperCase()}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="poster-over">
          <span className="poster-cat">{c.visibility === 'private' ? 'Private community' : 'Community'}</span>
          <span className="poster-title clamp-2">{c.name}</span>
          {c.description && <span className="poster-line clamp-2">{c.description}</span>}
          {c.topics.length > 0 && <span className="poster-foot clamp-1">{c.topics.slice(0, 3).map(t => shared.includes(t) ? `★ ${t}` : t).join(' · ')}</span>}
        </span>
      </Link>
      <div className="org-tile-act">
        {joined || already ? <Link className="btn sm" to={`/app/communities/${c.id}`}>Joined · Open</Link> : <button className="btn primary sm" disabled={busy} onClick={join}>Join</button>}
      </div>
    </article>
  )
}
