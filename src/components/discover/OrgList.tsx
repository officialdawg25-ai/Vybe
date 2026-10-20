import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck } from 'lucide-react'
import { discoverOrgs, ORG_KIND_LABEL, type OrgCard } from '../../lib/discover'
import { useAsync } from '../../lib/hooks'
import { Avatar, Empty, ErrorState, Spinner } from '../../ui'
import { FollowButton } from './FollowButton'

const KINDS: { id: string; label: string; kinds?: string[] }[] = [
  { id: 'all', label: 'All' }, { id: 'artist', label: 'Artists', kinds: ['artist', 'creator'] }, { id: 'venue', label: 'Venues', kinds: ['venue'] }, { id: 'organizer', label: 'Organisers', kinds: ['organizer', 'business', 'brand'] },
]

/** Artists, venues and organisers. Ordered by "has something coming up" then newest, never by follower count, so new local acts are findable. */
export function OrgList({ q }: { q: string }) {
  const [kind, setKind] = useState('all')
  const [followed, setFollowed] = useState(false)
  const k = KINDS.find(x => x.id === kind)!
  const list = useAsync(() => discoverOrgs({ kinds: k.kinds, q, followed }), [kind, q, followed])
  return (
    <div>
      <div className="d-filters">
        <div className="chips" role="group" aria-label="Type">
          {KINDS.map(x => <button key={x.id} className="chip" aria-pressed={kind === x.id} onClick={() => setKind(x.id)}>{x.label}</button>)}
          <button className="chip" aria-pressed={followed} onClick={() => setFollowed(v => !v)}>Following</button>
        </div>
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data === null ? (
        <p className="notice" role="status">Artists and venues need the latest database update.</p>
      ) : !list.data.length ? (
        <Empty title={followed ? 'You aren’t following anyone yet' : 'No pages found'} action={<Link className="btn primary" to="/org">Create a page</Link>}>{followed ? 'Follow artists, venues and organisers to see their events first.' : 'Artists, venues and organisers create pages in the organisation portal.'}</Empty>
      ) : (
        <ul className="org-list">{list.data.map(o => <OrgRow key={o.id} o={o} />)}</ul>
      )}
    </div>
  )
}

export function OrgRow({ o }: { o: OrgCard }) {
  return (
    <li className="org-row">
      <Link to={`/app/pages/${o.slug}`} className="org-link">
        <Avatar path={o.avatar_path} name={o.name} size="lg" />
        <span className="org-text">
          <span className="t-name clamp-1">{o.name}{o.verified && <BadgeCheck size={16} aria-label="Verified by VYBE" style={{ marginLeft: 4, color: 'var(--brand)', verticalAlign: '-3px' }} />}</span>
          <span className="t-meta">{ORG_KIND_LABEL[o.kind] ?? o.kind} · {o.upcoming ? `${o.upcoming} upcoming` : 'Nothing scheduled'} · {o.followers} {o.followers === 1 ? 'follower' : 'followers'}</span>
          {o.description && <span className="t-support clamp-2">{o.description}</span>}
        </span>
      </Link>
      <FollowButton type="organization" id={o.id} following={o.following} label={o.name} />
    </li>
  )
}
