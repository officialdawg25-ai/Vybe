import { Link } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { isMissingSchema } from '../lib/tickets'
import { Avatar, Empty, ErrorState, Sheet, Spinner } from '../ui'
import { NameTick } from './VerifiedBadge'
import { FollowButton } from './discover/FollowButton'

interface Person { id: string; username: string; display_name: string; avatar_path: string | null; verified_until: string | null; i_follow: boolean }

/** The people behind the Followers / Following counts on a profile. The database applies the owner's privacy choice. */
export function ConnectionsSheet({ userId, name, kind, me, onClose }: { userId: string; name: string; kind: 'followers' | 'following'; me: string | null; onClose: () => void }) {
  const list = useAsync(async () => {
    const { data, error } = await supabase.rpc('profile_connections', { p_user: userId, p_kind: kind, p_limit: 100, p_offset: 0 })
    if (error) { if (isMissingSchema(error)) return 'old' as const; throw error }
    return (data as Person[] | null) ?? ('private' as const)
  }, [userId, kind])
  const title = kind === 'followers' ? 'Followers' : 'Following'
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="conn">
        {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} />
          : list.data === 'private' ? <Empty title={`${name} keeps this private`}><Lock size={18} aria-hidden /> Only the people they choose can see who follows them and who they follow.</Empty>
          : list.data === 'old' ? <p className="notice" role="status">This list needs the latest VYBE update on the server.</p>
          : !list.data?.length ? <Empty title={kind === 'followers' ? 'No followers yet' : 'Not following anyone yet'}>{kind === 'followers' ? `When people follow ${name}, they show up here.` : `People ${name} follows show up here.`}</Empty>
          : <ul className="conn-list">{list.data.map(p => (
            <li key={p.id} className="conn-row">
              <Link to={`/app/u/${p.username}`} className="conn-who" onClick={onClose}>
                <Avatar size="sm" path={p.avatar_path} uid={p.id} name={p.display_name || p.username} />
                <span className="grow"><span className="t-name clamp-1"><NameTick name={p.display_name || p.username} profile={p} size={14} /></span><span className="t-meta clamp-1">@{p.username}</span></span>
              </Link>
              {p.id !== me && <FollowButton type="profile" id={p.id} following={p.i_follow} size="sm" label={p.display_name || p.username} />}
            </li>))}</ul>}
      </div>
    </Sheet>
  )
}
