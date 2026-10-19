import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Feed } from '../components/Feed'
import { FriendButton } from '../components/FriendButton'
import { fetchPosts } from '../lib/posts'
import { INTERESTS, loadRelations } from '../lib/friends'
import { rankByInterest, sharedInterests } from '../lib/feeds'
import { useAsync, useSubmit } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { formatEventTime } from '../lib/format'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast } from '../ui'
import type { Community, EventRow, PublicProfile } from '../lib/types'

type Person = PublicProfile & { interests: string[]; bio: string }

/**
 * Discover: find what is *new to you* — public plans, communities you haven't joined, people you don't know yet and
 * public posts from outside your circle. Everything is read under RLS, so private content never appears here.
 * Ordering is "soonest" for plans, "shared interests first" for communities and people, and "newest" for posts:
 * no popularity or trending claims, because VYBE has no such signal.
 */
export default function Discover() {
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const topic = INTERESTS.includes(params.get('topic') ?? '') ? params.get('topic')! : ''
  const [q, setQ] = useState('')
  useEffect(() => { document.title = 'Discover · VYBE' }, [])

  const mine = profile?.interests ?? []
  const chips = useMemo(() => [...new Set([...mine, ...INTERESTS])].slice(0, 15), [mine])

  const circle = useAsync(async () => {
    const [rels, mem] = await Promise.all([loadRelations(uid!), supabase.from('community_members').select('community_id').eq('user_id', uid!)])
    if (mem.error) throw mem.error
    // Active memberships and pending requests both mean "already dealt with": neither is suggested again.
    return { rels, joined: new Set((mem.data ?? []).map(r => r.community_id)) }
  }, [uid])

  const plans = useAsync(async () => {
    let query = supabase.from('events').select('*, profiles:host(id,username,display_name,avatar_path)')
      .eq('status', 'active').eq('visibility', 'public').neq('host', uid!).gte('starts_at', new Date().toISOString()).order('starts_at').limit(10)
    if (topic) query = query.or(`title.ilike.%${topic}%,description.ilike.%${topic}%`)
    const { data, error } = await query
    if (error) throw error
    return (data ?? []) as unknown as EventRow[]
  }, [uid, topic])

  const communities = useAsync(async () => {
    if (!circle.data) return [] as Community[]
    let query = supabase.from('communities').select('*').eq('visibility', 'public').order('created_at', { ascending: false }).limit(40)
    if (topic) query = query.contains('topics', [topic])
    const { data, error } = await query
    if (error) throw error
    const open = ((data ?? []) as Community[]).filter(c => !circle.data!.joined.has(c.id))
    return rankByInterest(open, topic ? [topic] : mine, c => c.topics).slice(0, 6)
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

  const friendIdsList = useMemo(() => [...(circle.data?.rels.entries() ?? [])].filter(([, v]) => v.status === 'accepted').map(([k]) => k), [circle.data])
  // Public posts from outside the circle; your own posts and your friends' posts live on Home.
  const loadPosts = useMemo(() => (cursor?: string) =>
    fetchPosts({ uid: uid!, cursor, publicOnly: true, excludeAuthors: [uid!, ...friendIdsList.slice(0, 150)], matching: topic || undefined }),
  [uid, friendIdsList, topic])

  const submit = (e: FormEvent) => { e.preventDefault(); const v = q.trim(); if (v.length >= 2) nav(`/app/search?q=${encodeURIComponent(v)}`) }
  const setTopic = (t: string) => setParams(t && t !== topic ? { topic: t } : {}, { replace: true })

  const nothingStructured = !plans.loading && !communities.loading && !people.loading && !plans.data?.length && !communities.data?.length && !people.data?.length

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
        <p className="t-support">Find plans, communities and people beyond your circle. What your friends are up to is on <Link to="/app" style={{ textDecoration: 'underline' }}>Home</Link>.</p>
        <form role="search" aria-label="Discover search" onSubmit={submit} className="row discover-search">
          <Search size={20} aria-hidden />
          <input className="input" type="search" aria-label="Search people, plans, posts and communities" placeholder="Search people, plans, posts, communities" value={q} onChange={e => setQ(e.target.value)} />
          <button className="btn primary" style={{ flex: 'none' }}>Search</button>
        </form>
        <div className="d-chips-inline">{interestChips}</div>
      </header>

      {nothingStructured && (
        <Empty title={topic ? `Nothing about ${topic} yet` : 'Nothing to explore yet'}
          action={<div className="row"><Link className="btn primary" to="/app/plans">Make a plan</Link><Link className="btn" to="/app/communities?new=1">Start a community</Link></div>}>
          {topic ? 'Try another interest, or clear the filter.' : 'As people on VYBE share plans and start communities, they will show up here.'}
        </Empty>
      )}

      {(plans.loading || plans.error || plans.data?.length) ? (
        <section aria-labelledby="d-plans" className="d-sec">
          <div className="row between"><h2 id="d-plans" className="t-section">Plans coming up</h2><Link to="/app/plans" className="t-meta">All plans</Link></div>
          {plans.loading ? <Spinner /> : plans.error ? <ErrorState message={plans.error} onRetry={plans.reload} /> : (
            <ul className="hscroll" aria-label="Upcoming public plans">
              {plans.data!.map(e => <li key={e.id}><PlanTile e={e} /></li>)}
            </ul>
          )}
        </section>
      ) : null}

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

      <section aria-labelledby="d-posts" className="d-sec">
        <h2 id="d-posts" className="t-section">Latest public posts{topic ? ` about ${topic}` : ''}</h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>Newest first, from people outside your circle.</p>
        {circle.loading ? <Spinner /> : circle.error ? <ErrorState message={circle.error} onRetry={circle.reload} /> : (
          <Feed key={topic} load={loadPosts} deps={[uid, friendIdsList.length, topic]} why={() => 'Public post'}
            empty={{ title: topic ? `No public posts about ${topic}` : 'No public posts to show', text: 'Public posts from people you don’t follow yet will appear here.' }} />
        )}
      </section>
    </div>
    <aside className="col-side" aria-label="Browse by interest">
      <section className="card" aria-labelledby="d-int">
        <h2 id="d-int" className="t-section" style={{ marginBottom: 8 }}>Browse by interest</h2>
        {interestChips}
        {topic && <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setTopic('')}>Clear filter</button>}
      </section>
    </aside>
    </div>
  )
}

function PlanTile({ e }: { e: EventRow }) {
  const d = new Date(e.starts_at)
  const month = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: e.timezone }).format(d)
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: e.timezone }).format(d)
  return (
    <Link to={`/app/plans/${e.id}`} className="plan-tile">
      <span className="plan-date" aria-hidden><span>{month}</span><b>{day}</b></span>
      <span className="t-name plan-title">{e.title}</span>
      <span className="t-meta clamp-1">{formatEventTime(e.starts_at, e.timezone)}</span>
      {e.location && <span className="t-meta clamp-1">{e.location}</span>}
      <span className="t-meta clamp-1">Hosted by {e.profiles?.display_name || e.profiles?.username}</span>
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
