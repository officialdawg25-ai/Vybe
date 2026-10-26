import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { CalendarDays, ImagePlus, Images, Radio, Ticket, UserPlus, UsersRound } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { HomeBillboard } from '../components/HomeBillboard'
import { MemoryRail } from '../components/MemoryRail'
import { GoLiveSheet, LiveNow } from '../components/LiveNow'
import { usePlace } from '../lib/location'
import { Feed } from '../components/Feed'
import { FeedSuggestion, SUGGESTION_KINDS, railsWithContent, setSuggestionPlace, snoozedKinds } from '../components/FeedSuggestions'
import { DEFAULT_CITY } from '../lib/cities'
import { fetchPosts, friendIds, savedIds, takeFirstPage } from '../lib/posts'
import { RAILS_PER_VISIT, friendsAndMe, pickRails, railSlot } from '../lib/feeds'
import { useAsync } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { formatEventTime } from '../lib/format'
import { Avatar, ErrorState, Spinner, Tabs } from '../ui'
import type { Post } from '../lib/types'
import { POSTED_EVENT } from '../lib/publisher'

/** Fired by the header logo / Home tab when tapped while already on Home: re-check the server for new posts. */
export const HOME_REFRESH = 'vybe:home-refresh'

type Tab = 'all' | 'friends' | 'pages' | 'plans' | 'saved'

/**
 * Home: everything in your world you are allowed to see, newest first — friends, public posts from anyone on VYBE,
 * communities you belong to, organization pages and plans people have shared. Privacy is enforced by Row Level
 * Security on every query, so a post only appears if you could open it.
 */
export default function Home() {
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const [place] = usePlace(profile)
  const [tab, setTab] = useState<Tab>('all')
  const [goLive, setGoLive] = useState(false)
  const loc = useLocation()
  // A post the server just confirmed (from the composer). Taken once, then cleared from history so a reload never replays it.
  const [posted, setPosted] = useState<Post | null>(() => (loc.state as { posted?: Post } | null)?.posted ?? null)
  useEffect(() => { if (posted) nav('.', { replace: true, state: null }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Published in the background (lib/publisher): shown at the top as soon as the server confirms it.
  useEffect(() => {
    const on = (e: Event) => setPosted((e as CustomEvent<Post>).detail)
    window.addEventListener(POSTED_EVENT, on); return () => window.removeEventListener(POSTED_EVENT, on)
  }, [])
  useEffect(() => { document.title = 'Home · VYBE' }, [])

  // A few suggestion rails between "For you" posts: every kind is checked at once and the first few (random order, each
  // kind once, hidden kinds left out) that have enough content take the slots, so a slot is never left empty while
  // another kind has something to show.
  const [order] = useState(() => pickRails(SUGGESTION_KINDS, snoozedKinds()))
  // Distance ranking only from a place the member chose or has on their profile, never Discover's default city.
  const real = place === DEFAULT_CITY ? null : place
  // Checked once the browser is idle after Home opens (at most ~2 s), so the first posts and their pictures go first.
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    if (w.requestIdleCallback) { const id = w.requestIdleCallback(() => setIdle(true), { timeout: 2000 }); return () => w.cancelIdleCallback?.(id) }
    const t = window.setTimeout(() => setIdle(true), 1200); return () => window.clearTimeout(t)
  }, [])
  const rails = useAsync(async () => {
    if (!idle || !uid) return []
    setSuggestionPlace(real)
    return (await railsWithContent(order, uid)).slice(0, RAILS_PER_VISIT)
  }, [idle, uid, order, real?.lat, real?.lng])
  const between = useMemo(() => (i: number) => { const k = rails.data?.[railSlot(i)]; return k ? <FeedSuggestion key={`sug-${k}`} kind={k} /> : null }, [rails.data])

  const friends = useAsync(() => friendIds(uid!), [uid])

  // Only the Friends tab depends on the friend list; tying every tab to it fetched the feed twice on each visit.
  const friendDep = tab === 'friends' ? friends.data : null
  const load = useMemo(() => async (cursor?: string) => {
    switch (tab) {
      case 'saved': { const ids = await savedIds(); return ids.length ? fetchPosts({ uid: uid!, cursor, ids }) : [] }
      case 'friends': return fetchPosts({ uid: uid!, cursor, authors: friendsAndMe(uid!, friends.data ?? []) })
      case 'pages': return fetchPosts({ uid: uid!, cursor, pagesOnly: true })
      case 'plans': return fetchPosts({ uid: uid!, cursor, withEvent: true })
      default: return (!cursor && takeFirstPage(uid!)) || fetchPosts({ uid: uid!, cursor })
    }
  }, [tab, uid, friendDep]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = profile?.display_name || profile?.username || ''
  const empty: Record<Tab, { title: string; text: string; action?: React.ReactNode }> = {
    all: { title: 'Nothing here yet', text: 'Share something, add friends, or explore what’s happening near you.', action: <div className="row"><button className="btn primary" onClick={() => nav('/app/create')}>Create a post</button><Link className="btn" to="/app/discover">Explore Discover</Link></div> },
    friends: { title: 'Nothing from friends yet', text: 'Add friends to see what they share.', action: <Link className="btn primary" to="/app/friends">Find friends</Link> },
    pages: { title: 'No page posts yet', text: 'Organizations you can see will show their updates here.' },
    plans: { title: 'No shared plans yet', text: 'When people share a plan to their feed it shows up here.', action: <Link className="btn primary" to="/app/discover">Find plans near you</Link> },
    saved: { title: 'No saved posts', text: 'Tap the bookmark on a post to save it privately.' },
  }

  return (
    <div className="cols">
      <section className="col-main" aria-label="Your feed">
        <h1 className="sr-only">Home</h1>

        <HomeBillboard place={place} />

        {/* Post first, then memories: the composer sits between the billboard and the memory rail. */}
        <div className="compose-bar">
          <Link to={profile ? `/app/u/${profile.username}` : '/app/settings'} aria-label="Your profile"><Avatar path={profile?.avatar_path} name={name || '?'} /></Link>
          <button className="compose-pill" onClick={() => nav('/app/create')}>What’s on your mind{name ? `, ${name.split(' ')[0]}` : ''}?</button>
          <button className="icon-btn" aria-label="Add a photo or video" onClick={() => nav('/app/create')}><ImagePlus size={24} /></button>
          <button className="icon-btn live-btn" aria-label="Go live" onClick={() => setGoLive(true)}><Radio size={24} /></button>
        </div>

        <LiveNow />
        <MemoryRail />
        {goLive && <GoLiveSheet onClose={() => setGoLive(false)} />}

        <Tabs value={tab} onChange={setTab} items={[{ id: 'all', label: 'For you' }, { id: 'friends', label: 'Friends' }, { id: 'pages', label: 'Pages' }, { id: 'plans', label: 'Plans' }, { id: 'saved', label: 'Saved' }]} />
        {friends.loading && tab === 'friends' ? <Spinner /> : friends.error && tab === 'friends' ? <ErrorState message={friends.error} onRetry={friends.reload} /> : (
          <Feed key={tab} load={load} deps={[tab, friendDep]} empty={empty[tab]}
            cacheKey={`home:${uid}:${tab}`} refreshOn={HOME_REFRESH} prepend={tab === 'all' || tab === 'friends' ? posted : null}
            after={tab === 'all' ? between : undefined} />
        )}
      </section>
      <aside className="col-side" aria-label="Your plans and shortcuts">
        <UpcomingPlans />
        <Shortcuts />
      </aside>

    </div>
  )
}

/** Plans you are going to or hosting — straight from your RSVPs, not recommendations. */
function UpcomingPlans() {
  const { uid } = useAuth()
  const plans = useAsync(async () => {
    const now = new Date().toISOString()
    const [going, hosting] = await Promise.all([
      supabase.from('event_rsvps').select('events!inner(id,title,starts_at,timezone,location,status)').eq('user_id', uid!).eq('status', 'going').gte('events.starts_at', now).eq('events.status', 'active').limit(10),
      supabase.from('events').select('id,title,starts_at,timezone,location,status').eq('host', uid!).eq('status', 'active').gte('starts_at', now).order('starts_at').limit(10),
    ])
    if (going.error) throw going.error
    if (hosting.error) throw hosting.error
    type E = { id: string; title: string; starts_at: string; timezone: string; location: string | null }
    const all = new Map<string, E>()
    for (const r of (going.data ?? []) as unknown as { events: E }[]) all.set(r.events.id, r.events)
    for (const e of (hosting.data ?? []) as E[]) all.set(e.id, e)
    return [...all.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 4)
  }, [uid])
  return (
    <section className="card" aria-labelledby="plans-h">
      <div className="row between"><h2 id="plans-h" className="t-section">Your plans</h2><Link to="/app/plans" className="t-meta">See all</Link></div>
      {plans.loading ? <Spinner /> : plans.error ? <p className="t-meta">Couldn’t load your plans. <button className="linklike" onClick={plans.reload}>Try again</button></p>
        : !plans.data?.length ? <p className="t-meta" style={{ marginTop: 8 }}>Nothing planned yet. <Link to="/app/discover" style={{ textDecoration: 'underline' }}>See what’s on near you</Link>.</p>
        : <div className="list">{plans.data.map(e => (
            <Link key={e.id} to={`/app/plans/${e.id}`} className="item link" style={{ display: 'block' }}>
              <div className="t-name clamp-1">{e.title}</div>
              <div className="t-meta">{formatEventTime(e.starts_at, e.timezone)}{e.location ? ` · ${e.location}` : ''}</div>
            </Link>))}</div>}
    </section>
  )
}

function Shortcuts() {
  return (
    <section className="card" aria-labelledby="short-h">
      <h2 id="short-h" className="t-section" style={{ marginBottom: 4 }}>Shortcuts</h2>
      <div className="list">
        <Link to="/app/tickets" className="item row link"><Ticket size={20} aria-hidden /><span className="grow">My tickets</span></Link>
        <Link to="/app/friends" className="item row link"><UserPlus size={20} aria-hidden /><span className="grow">Friends and requests</span></Link>
        <Link to="/app/communities" className="item row link"><UsersRound size={20} aria-hidden /><span className="grow">Your communities</span></Link>
        <Link to="/app/plans" className="item row link"><CalendarDays size={20} aria-hidden /><span className="grow">Plans</span></Link>
        <Link to="/app/media" className="item row link"><Images size={20} aria-hidden /><span className="grow">Media library</span></Link>
      </div>
    </section>
  )
}
