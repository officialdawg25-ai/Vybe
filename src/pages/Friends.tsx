import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { loadRelations } from '../lib/friends'
import { FriendButton } from '../components/FriendButton'
import { Avatar, Empty, ErrorState, Spinner, Tabs } from '../ui'
import type { PublicProfile } from '../lib/types'

type Tab = 'friends' | 'requests' | 'find'
const COLS = 'id,username,display_name,avatar_path,interests,bio'
type P = PublicProfile & { interests: string[]; bio: string }

export default function Friends() {
  const { uid, profile } = useAuth()
  const [tab, setTab] = useState<Tab>('friends')
  useEffect(() => { document.title = 'Friends · VYBE' }, [])

  const rels = useAsync(() => loadRelations(uid!), [uid])
  const people = useAsync(async () => {
    const r = rels.data
    if (!r) return [] as P[]
    const ids = [...r.entries()].filter(([, v]) => (tab === 'friends' ? v.status === 'accepted' : tab === 'requests' ? v.status === 'pending' && !v.outgoing : false)).map(([k]) => k)
    if (tab === 'find') {
      // Suggestions: people sharing at least one interest, otherwise newest members; excludes existing relations.
      let q = supabase.from('profiles').select(COLS).neq('id', uid!).limit(40)
      if (profile?.interests?.length) q = q.overlaps('interests', profile.interests)
      const { data, error } = await q
      if (error) throw error
      let out = ((data ?? []) as P[]).filter(p => !r.has(p.id))
      if (out.length < 10) {
        const { data: more } = await supabase.from('profiles').select(COLS).neq('id', uid!).order('id').limit(30)
        out = [...out, ...((more ?? []) as P[]).filter(p => !r.has(p.id) && !out.some(o => o.id === p.id))]
      }
      return out.slice(0, 20)
    }
    if (!ids.length) return []
    const { data, error } = await supabase.from('profiles').select(COLS).in('id', ids)
    if (error) throw error
    return (data ?? []) as P[]
  }, [tab, rels.data])

  const pendingIn = rels.data ? [...rels.data.values()].filter(v => v.status === 'pending' && !v.outgoing).length : 0

  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 12 }}>Friends</h1>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'friends', label: 'Friends' }, { id: 'requests', label: pendingIn ? `Requests (${pendingIn})` : 'Requests' }, { id: 'find', label: 'Find people' }]} />
      {tab === 'find' && <p className="row" style={{ marginBottom: 12 }}><Link className="btn primary" to="/app/people">Discover people to follow</Link></p>}
      {rels.error ? <ErrorState message={rels.error} onRetry={rels.reload} /> : rels.loading || people.loading ? <Spinner /> : people.error ? <ErrorState message={people.error} onRetry={people.reload} /> : !people.data?.length ? (
        tab === 'friends' ? <Empty title="No friends yet" action={<button className="btn primary" onClick={() => setTab('find')}>Find people</button>}>Friends see your friends-only posts and can message you.</Empty>
          : tab === 'requests' ? <Empty title="No pending requests">When someone adds you, it will show up here.</Empty>
          : <Empty title="No suggestions right now">Add interests in Settings to get better suggestions, or try Search.</Empty>
      ) : (
        <div className="list">
          {people.data.map(p => (
            <div key={p.id} className="item row">
              <Link to={`/app/u/${p.username}`}><Avatar path={p.avatar_path} name={p.display_name || p.username} /></Link>
              <Link to={`/app/u/${p.username}`} className="grow">
                <div className="t-name clamp-1">{p.display_name || p.username}</div>
                <div className="t-meta clamp-1">@{p.username}{tab === 'find' && p.interests?.length ? ` · ${p.interests.filter(i => profile?.interests?.includes(i)).slice(0, 2).join(', ') || p.interests.slice(0, 2).join(', ')}` : ''}</div>
              </Link>
              <FriendButton other={p.id} rel={rels.data?.get(p.id)} onChanged={rels.reload} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
