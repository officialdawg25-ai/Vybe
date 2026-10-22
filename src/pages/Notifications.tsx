import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { Avatar, Empty, ErrorState, Spinner, toast, errMsg } from '../ui'
import { timeAgo } from '../lib/format'
import type { PublicProfile } from '../lib/types'

interface N { id: string; type: string; entity_type: string | null; entity_id: string | null; read_at: string | null; created_at: string; actor: PublicProfile | null }

const TEXT: Record<string, string> = {
  friend_request: 'sent you a friend request',
  friend_accepted: 'accepted your friend request',
  reaction: 'liked your post',
  comment: 'commented on your post',
  event_invite: 'invited you to a plan',
  rsvp: "is going to your plan",
  community_join: 'wants to join or joined your community',
  new_event: 'published a new event you may like',
  event_update: 'changed the details of an event you’re going to',
  event_cancelled: 'cancelled an event you were going to',
  live_started: 'is live now at an event you’re following',
  org_member: 'joined your organisation’s team',
  org_rsvp: 'is going to your organisation’s event',
  org_follow: 'followed your organisation’s page',
}
function href(n: N, actor?: PublicProfile | null) {
  if (n.type === 'security') return '/app/settings/chat-security'
  if (n.type === 'campaign') return '/org'
  if (n.type === 'org_member' || n.type === 'org_follow') return '/org'
  if (n.entity_type === 'post') return `/app/posts/${n.entity_id}`
  if (n.entity_type === 'live') return `/app/live/${n.entity_id}`
  if (n.entity_type === 'event') return `/app/plans/${n.entity_id}`
  if (n.entity_type === 'community') return `/app/communities/${n.entity_id}`
  if (n.type.startsWith('friend') && actor) return `/app/u/${actor.username}`
  return '/app'
}

export default function Notifications() {
  const { data, loading, error, reload } = useAsync(async () => {
    const { data, error } = await supabase.from('notifications').select('id,type,entity_type,entity_id,read_at,created_at,actor:actor_id(id,username,display_name,avatar_path)').order('created_at', { ascending: false }).limit(50)
    if (error) throw error
    return (data ?? []) as unknown as N[]
  }, [])
  useEffect(() => { document.title = 'Notifications · VYBE' }, [])
  const notify = () => window.dispatchEvent(new Event('vybe:notifications'))
  const markAll = async () => {
    const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)
    if (error) return toast(errMsg(error))
    reload(); notify()
  }
  const open = async (n: N) => {
    if (!n.read_at) { await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id); notify() }
  }
  const unread = data?.some(n => !n.read_at)
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h1 className="t-title">Notifications</h1>
        {unread && <button className="btn sm" onClick={markAll}>Mark all read</button>}
      </div>
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} /> : !data?.length ? <Empty title="You're all caught up">Likes, comments, invitations and friend requests will appear here.</Empty> : (
        <div className="list">
          {data.map(n => (
            <Link key={n.id} to={href(n, n.actor)} onClick={() => open(n)} className="item row link" style={{ padding: '12px 8px', background: n.read_at ? undefined : 'var(--brand-soft)' }}>
              {n.type === 'campaign' ? <Avatar path={null} name="VYBE" /> : <Avatar path={n.actor?.avatar_path} uid={n.actor?.id} name={n.actor?.display_name || n.actor?.username || '?'} />}
              <div className="grow">
                {n.type === 'security'
                  ? <p><b>Security alert</b> — your chat keys or recovery settings changed. If this wasn’t you, tap to review and cancel any recovery.</p>
                  : n.type === 'campaign'
                  ? <p><b>VYBE</b> reviewed one of your organisation’s campaigns. Open the organisation’s Campaigns tab to see the decision.</p>
                  : <p><b>{n.actor?.display_name || n.actor?.username || 'Someone'}</b> {TEXT[n.type] ?? 'did something'}</p>}
                <p className="t-meta">{timeAgo(n.created_at)}{!n.read_at && ' · New'}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
