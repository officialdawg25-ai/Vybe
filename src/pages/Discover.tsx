import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Composer } from '../components/Composer'
import { Feed } from '../components/Feed'
import { fetchPosts, friendIds, savedIds } from '../lib/posts'
import { supabase } from '../lib/supabase'
import { formatEventTime } from '../lib/format'
import { Tabs } from '../ui'
import type { EventRow, Post } from '../lib/types'

type Mode = 'everyone' | 'friends' | 'saved'

export default function Discover() {
  const { uid } = useAuth()
  const [mode, setMode] = useState<Mode>('everyone')
  const [fresh, setFresh] = useState<Post | null>(null)
  const [friends, setFriends] = useState<string[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  useEffect(() => { document.title = 'Discover · VYBE' }, [])
  useEffect(() => { friendIds(uid!).then(setFriends, () => {}) }, [uid])
  useEffect(() => {
    supabase.from('events').select('*, profiles:host(id,username,display_name,avatar_path)')
      .eq('status', 'active').gte('starts_at', new Date().toISOString()).order('starts_at').limit(3)
      .then(({ data }) => setEvents((data ?? []) as unknown as EventRow[]))
  }, [])
  const friendSet = useMemo(() => new Set(friends), [friends])

  const load = useMemo(() => async (cursor?: string) => {
    if (mode === 'friends') return fetchPosts({ uid: uid!, cursor, authors: [...friends, uid!] })
    if (mode === 'saved') { const ids = await savedIds(); return ids.length ? fetchPosts({ uid: uid!, cursor, ids }) : [] }
    return fetchPosts({ uid: uid!, cursor })
  }, [mode, uid, friends])

  return (
    <>
      <h1 className="sr-only">Discover</h1>
      <Composer onPosted={setFresh} />
      {events.length > 0 && (
        <section aria-label="Coming up" style={{ margin: '16px 0' }}>
          <div className="row between"><h2 className="t-section">Coming up</h2><Link to="/app/plans" className="t-meta">See all plans</Link></div>
          <div className="list">
            {events.map(e => (
              <Link key={e.id} to={`/app/plans/${e.id}`} className="item row link">
                <div className="grow"><div className="t-name clamp-1">{e.title}</div><div className="t-meta">{formatEventTime(e.starts_at, e.timezone)}{e.location ? ` · ${e.location}` : ''}</div></div>
              </Link>
            ))}
          </div>
        </section>
      )}
      <Tabs value={mode} onChange={setMode} items={[{ id: 'everyone', label: 'Everyone' }, { id: 'friends', label: 'Friends' }, { id: 'saved', label: 'Saved' }]} />
      <Feed key={mode} load={load} deps={[mode, friends.length]} prepend={mode === 'saved' ? null : fresh}
        why={p => (p.author === uid ? 'Your post' : friendSet.has(p.author) ? 'From a friend' : p.visibility === 'community' ? 'From a community you belong to' : 'Public post')}
        empty={mode === 'friends'
          ? { title: 'Nothing from friends yet', text: 'Add friends to see what they share. Find people from the Friends tab.' }
          : mode === 'saved' ? { title: 'No saved posts', text: 'Tap the bookmark on a post to save it privately.' }
          : { title: 'No posts yet', text: 'Be the first to share something.' }} />
    </>
  )
}
