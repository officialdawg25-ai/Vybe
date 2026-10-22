import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Collapse } from '../components/Collapse'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Baby, ChevronDown, Drama, Flame, GraduationCap, Handshake, HeartHandshake, Laugh, LayoutGrid, LocateFixed, MapPin, Mic, MicVocal, Moon, Music2,
  Palette, Radio, Search, Shapes, Sparkles, Star, Tent, Ticket, Trophy, UsersRound, UtensilsCrossed, Wifi, Wrench,
} from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { FriendButton } from '../components/FriendButton'
import { LocationPicker } from '../components/LocationPicker'
import { CategoryRail, type Tile } from '../components/discover/CategoryRail'
// The banner is part of the page's first render (it is the largest thing on screen); its data is requested as the page
// starts (prefetchBillboard), so it fills in moments later instead of after a second download.
import { DiscoverHero } from '../components/HomeBillboard'
import { EventPoster } from '../components/discover/EventPoster'
import { LiveList } from '../components/discover/LiveList'
import { OrgList, OrgRow } from '../components/discover/OrgList'
import { ResultsView, type Preset, type Scope } from '../components/discover/ResultsView'
import { INTERESTS, loadRelations } from '../lib/friends'
import { rankByInterest, sharedInterests } from '../lib/feeds'
import { discoverEvents, discoverLive, discoverOrgs, rangeBounds, shortDate, useCategories, type DiscoverEvent } from '../lib/discover'
import { isMissingSchema } from '../lib/tickets'
import { locateMe, usePlace } from '../lib/location'
import { prefetchBillboard } from '../lib/promos'
import { useAsync, useSubmit } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../ui'
import type { Community, PublicProfile } from '../lib/types'

export { rangeBounds }
type Person = PublicProfile & { interests: string[]; bio: string }
type Filter = 'foryou' | 'nearby' | 'trending' | 'following'
const FILTERS: { id: Filter; label: string }[] = [{ id: 'foryou', label: 'For you' }, { id: 'nearby', label: 'Nearby' }, { id: 'trending', label: 'Trending' }, { id: 'following', label: 'Following' }]
const RADII = [10, 25, 50, 100, 250]

// Tiles that are not a single admin category. Category tiles come from event_categories (admin-configured), so a new
// category appears here without a code change; only its icon and colour fall back to a default.
const ICONS: Record<string, Tile['icon']> = {
  concerts: MicVocal, festivals: Tent, comedy: Laugh, theatre: Drama, 'open-mic': Mic, nightlife: Moon, 'arts-culture': Palette, sports: Trophy,
  workshops: Wrench, networking: Handshake, food: UtensilsCrossed, family: Baby, student: GraduationCap, community: HeartHandshake, other: Shapes,
}
const ACCENTS = ['#e0457b', '#7c4dff', '#f08a24', '#1f9d8b', '#3b6fe0', '#c2410c', '#0f766e', '#9333ea', '#be123c', '#2563eb', '#b45309', '#0e7490', '#4d7c0f', '#a21caf', '#475569']
const SPECIAL = ['all', 'music', 'things', 'artists', 'communities', 'live', 'online'] as const
// Old links (?mode=…) keep working: they land on the matching tile.
const LEGACY: Record<string, string> = { concerts: 'music', events: 'things', artists: 'artists', communities: 'communities', live: 'live' }

/**
 * Discover: music, concerts, events, artists, communities and event broadcasts around a place you choose.
 * Categories are a row of visual tiles you swipe through (or arrow through with the keyboard); the choice lives in the URL
 * (?cat=…&f=…) so it can be shared and survives back/forward. Home stays the social feed; individual live streams stay on
 * Home/Live. Order is by time, distance or the documented trending score, and every number shown comes from the database.
 */

export default function Discover() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const legacyTopic = params.get('topic')
  const cats = useCategories()
  const rawCat = params.get('cat') ?? LEGACY[params.get('mode') ?? ''] ?? (legacyTopic === 'Music' ? 'music' : 'all')
  const cat = (SPECIAL as readonly string[]).includes(rawCat) || cats.some(c => c.slug === rawCat) || !cats.length ? rawCat : 'all'
  const filter: Filter = FILTERS.find(f => f.id === params.get('f'))?.id ?? 'foryou'
  const topic = INTERESTS.includes(legacyTopic ?? '') && legacyTopic !== 'Music' ? legacyTopic! : ''
  const [place, setPlace] = usePlace(profile)
  // The banner's data starts loading with the page, in parallel with the banner's own code (see prefetchBillboard).
  useState(() => { if (!params.get('cat') && !params.get('mode') && !params.get('f')) prefetchBillboard(place, 'discover') })
  const [scopeKind, setScopeKind] = useState<'all' | 'place'>(() => { try { return sessionStorage.getItem('vybe:discover-scope') === 'all' ? 'all' : 'place' } catch { return 'place' } })
  const [radius, setRadius] = useState(50)
  const [picking, setPicking] = useState(false)
  const [locating, setLocating] = useState(false)
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useEffect(() => { document.title = 'Discover · VYBE' }, [])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim().length >= 2 ? q.trim() : ''), 300); return () => clearTimeout(t) }, [q])
  const setScope = (k: 'all' | 'place') => { setScopeKind(k); try { sessionStorage.setItem('vybe:discover-scope', k) } catch { /* ignore */ } }
  const scope: Scope = scopeKind === 'all' ? { label: 'all locations' } : { lat: place.lat, lng: place.lng, radiusKm: radius, label: place.name.replace(/^Near /, '') }
  // Choosing changes the URL in place (no reload, no new history entry per swipe).
  const go = (next: { cat?: string; f?: Filter }) => {
    const c = next.cat ?? cat, f = next.f ?? filter
    const p: Record<string, string> = {}
    if (c !== 'all') p.cat = c
    if (f !== 'foryou') p.f = f
    setParams(p, { replace: true })
  }
  const setMode = (m: string) => go({ cat: LEGACY[m] ?? m })

  // One request gives every tile a real cover: the first upcoming plan with artwork in that category (none => colour and icon).
  const art = useAsync(async () => (await discoverEvents({ ...rangeBounds('any'), lat: scope.lat, lng: scope.lng, radiusKm: scope.radiusKm, limit: 60 }).catch(() => null)) ?? [], [JSON.stringify(scope)])
  const tiles = useMemo<Tile[]>(() => {
    const rows = (art.data ?? []).filter(e => e.cover_path)
    const cover = (pick: (e: DiscoverEvent) => boolean) => rows.find(pick)?.cover_path ?? null
    const groupOf = new Map(cats.map(c => [c.slug, c.group_key]))
    return [
      { id: 'all', label: 'All', icon: LayoutGrid, accent: '#334155', art: null },
      { id: 'music', label: 'Concerts & music', icon: Music2, accent: '#e0457b', art: cover(e => groupOf.get(e.category ?? '') === 'concerts') },
      { id: 'things', label: 'Things to do', icon: Sparkles, accent: '#7c4dff', art: cover(e => groupOf.get(e.category ?? '') === 'events') },
      ...cats.map((c, i) => ({ id: c.slug, label: c.label, icon: ICONS[c.slug] ?? Shapes, accent: ACCENTS[i % ACCENTS.length], art: cover(e => e.category === c.slug) })),
      { id: 'artists', label: 'Artists & venues', icon: Star, accent: '#b45309', art: null },
      { id: 'communities', label: 'Communities', icon: UsersRound, accent: '#0f766e', art: null },
      { id: 'live', label: 'Live from events', icon: Radio, accent: '#be123c', art: null },
      { id: 'online', label: 'Online', icon: Wifi, accent: '#2563eb', art: cover(e => e.format === 'online') },
    ]
  }, [cats, art.data])

  const nearMe = async () => {
    setLocating(true)
    try { setPlace(await locateMe()); setScope('place') } catch (e) { toast(errMsg(e)) } finally { setLocating(false) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (cat === 'all' && filter === 'foryou' && q.trim().length >= 2) nav(`/app/search?q=${encodeURIComponent(q.trim())}`) }
  const placeless = cat === 'communities' || cat === 'live' || cat === 'artists'
  const label = tiles.find(t => t.id === cat)?.label ?? 'All'

  // What the results start from for the chosen tile and filter (the member can still change every filter there).
  const preset: Preset = {
    categories: cats.some(c => c.slug === cat) ? [cat] : undefined,
    format: cat === 'online' ? 'online' : undefined,
    followed: filter === 'following' || undefined,
    sort: filter === 'nearby' && scope.lat != null ? 'nearest' : undefined,
  }
  const group = cat === 'music' || cats.find(c => c.slug === cat)?.group_key === 'concerts' ? 'concerts' : 'events'

  let body: React.ReactNode
  if (cat === 'artists') body = <OrgList q={dq} key={filter} />
  else if (cat === 'communities') body = <CommunityBrowse q={dq} topic={topic} />
  else if (cat === 'live') body = <LiveList />
  else if (filter === 'nearby' && scope.lat == null) body = <NeedPlace onPick={() => { setScope('place'); setPicking(true) }} onNearMe={nearMe} locating={locating} />
  else if (filter === 'trending' && cat === 'all') body = <TrendingView scope={scope} />
  else if (filter === 'following' && cat === 'all') body = <FollowingView q={dq} scope={scope} />
  else if (cat === 'all' && filter === 'foryou' && !dq) body = <ForYou scope={scope} topic={topic} placeName={scope.label} setMode={setMode} />
  else if (!(SPECIAL as readonly string[]).includes(cat) && !cats.length) body = <Spinner />
  else body = <ResultsView key={`${cat}|${filter}`} group={group} q={dq} scope={scope} preset={preset} />

  return (
    <div className="cols">
      <div className="col-main discover shz">
        {cat === 'all' && filter === 'foryou' && <DiscoverHero place={place} />}
        <header className="shz-head">
          <h1 className="t-display-sm">Discover</h1>
          <form role="search" aria-label="Search Discover" onSubmit={submit} className="dsearch">
            <Search size={20} aria-hidden />
            <input type="search" aria-label="Search" placeholder={cat === 'artists' ? 'Search artists, venues, organisers' : cat === 'communities' ? 'Search communities' : 'Search events, artists, venues, towns'} value={q} onChange={e => setQ(e.target.value)} />
          </form>
          {!placeless && (
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
          {!placeless && (
            <div className="dfilters" role="tablist" aria-label="Show">
              {FILTERS.map(f => <button key={f.id} role="tab" type="button" className="dfilter" aria-selected={filter === f.id} onClick={() => go({ f: f.id })}>{f.id === 'trending' && <Flame size={14} aria-hidden />}{f.label}</button>)}
            </div>
          )}
        </header>
        <CategoryRail tiles={tiles} selected={cat} onSelect={id => go({ cat: id })} />
        <h2 className="sr-only" aria-live="polite">{label}{filter !== 'foryou' && !placeless ? ` · ${FILTERS.find(f => f.id === filter)!.label}` : ''}</h2>
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
      {picking && <LocationPicker title="Explore a place" onPick={p => { setPlace(p); setScope('place') }} onClose={() => setPicking(false)} />}
    </div>
  )
}

function NeedPlace({ onPick, onNearMe, locating }: { onPick: () => void; onNearMe: () => void; locating: boolean }) {
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
  return (
    <Link to={`/app/plans/${t.id}`} className="poster">
      <div className="poster-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {!cover && <span className="poster-initial" aria-hidden>{t.title.charAt(0).toUpperCase()}</span>}
        {t.trending && <span className="pill-live"><Flame size={12} aria-hidden /> Trending</span>}
      </div>
      <span className="poster-date">{shortDate(t.starts_at, t.timezone)}</span>
      <span className="poster-title clamp-2">{t.title}</span>
      <span className="t-meta clamp-1"><MapPin size={12} aria-hidden /> {[t.venue, t.city].filter(Boolean).join(', ') || 'Location to be announced'}</span>
      {t.going > 0 && <span className="t-meta poster-foot"><b>{t.going} going</b></span>}
    </Link>
  )
}

/* ------------------------------------------------------------------ Following */
function FollowingView({ q, scope }: { q: string; scope: Scope }) {
  const orgs = useAsync(() => discoverOrgs({ followed: true, limit: 12 }), [])
  return (
    <>
      {(orgs.data?.length ?? 0) > 0 && (
        <section className="d-sec" aria-label="Pages you follow">
          <h2 className="t-section">Pages you follow</h2>
          <ul className="org-list">{orgs.data!.slice(0, 4).map(o => <OrgRow key={o.id} o={o} />)}</ul>
        </section>
      )}
      <ResultsView group="events" q={q} scope={scope} preset={{ followed: true }} />
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
