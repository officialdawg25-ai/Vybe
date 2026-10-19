import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, UserPlus, UsersRound } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Composer } from '../components/Composer'
import { Feed } from '../components/Feed'
import { fetchPosts, friendIds, myCommunityIds, savedIds } from '../lib/posts'
import { homeFilter, homeReason } from '../lib/feeds'
import { useAsync } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { formatEventTime } from '../lib/format'
import { ErrorState, Spinner, Tabs } from '../ui'
import type { Post } from '../lib/types'

type Tab = 'feed' | 'saved'

/** Home: keep up with your own social world — friends, yourself and the communities you belong to. Nothing from strangers. */
export default function Home() {
  const { uid } = useAuth()
  const [tab, setTab] = useState<Tab>('feed')
  const [fresh, setFresh] = useState<Post | null>(null)
  useEffect(() => { document.title = 'Home · VYBE' }, [])

  const circle = useAsync(async () => {
    const [friends, communities] = await Promise.all([friendIds(uid!), myCommunityIds(uid!)])
    return { friends, communities }
  }, [uid])
  const friendSet = useMemo(() => new Set(circle.data?.friends ?? []), [circle.data])

  const load = useMemo(() => async (cursor?: string) => {
    if (tab === 'saved') { const ids = await savedIds(); return ids.length ? fetchPosts({ uid: uid!, cursor, ids }) : [] }
    return fetchPosts({ uid: uid!, cursor, or: homeFilter(uid!, circle.data?.friends ?? [], circle.data?.communities ?? []) })
  }, [tab, uid, circle.data])

  const noCircle = circle.data && !circle.data.friends.length && !circle.data.communities.length
  return (
    <div className="cols">
      <section className="col-main" aria-label="Your feed">
        <h1 className="sr-only">Home</h1>
        <Composer onPosted={setFresh} />
        <Tabs value={tab} onChange={setTab} items={[{ id: 'feed', label: 'Your feed' }, { id: 'saved', label: 'Saved' }]} />
        {circle.loading ? <Spinner /> : circle.error ? <ErrorState message={circle.error} onRetry={circle.reload} /> : (
          <Feed key={tab} load={load} deps={[tab, circle.data]} prepend={tab === 'saved' ? null : fresh}
            why={p => homeReason(p, uid!, friendSet)}
            empty={tab === 'saved'
              ? { title: 'No saved posts', text: 'Tap the bookmark on a post to save it privately.' }
              : noCircle
                ? { title: 'Build your feed', text: 'Home shows what your friends and communities share. Add a few friends or join a community — or post something yourself.',
                    action: <div className="row"><Link className="btn primary" to="/app/friends">Find friends</Link><Link className="btn" to="/app/discover">Explore Discover</Link></div> }
                : { title: 'Nothing new yet', text: 'Your friends and communities haven’t posted. Share something, or look for more people in Discover.' }} />
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
        : !plans.data?.length ? <p className="t-meta" style={{ marginTop: 8 }}>Nothing planned yet. <Link to="/app/plans" style={{ textDecoration: 'underline' }}>Make a plan</Link> or RSVP to one from Discover.</p>
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
      <h2 id="short-h" className="t-section" style={{ marginBottom: 4 }}>Grow your circle</h2>
      <div className="list">
        <Link to="/app/friends" className="item row link"><UserPlus size={20} aria-hidden /><span className="grow">Friends and requests</span></Link>
        <Link to="/app/communities" className="item row link"><UsersRound size={20} aria-hidden /><span className="grow">Your communities</span></Link>
        <Link to="/app/plans" className="item row link"><CalendarDays size={20} aria-hidden /><span className="grow">Plans</span></Link>
      </div>
    </section>
  )
}
