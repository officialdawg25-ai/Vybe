import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Play, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { loadSuggestions, type Suggestion } from '../pages/People'
import { discoverEvents, discoverOrgs, shortDate, ORG_KIND_LABEL, type DiscoverEvent, type OrgCard } from '../lib/discover'
import { fetchPosts } from '../lib/posts'
import { shuffled } from '../lib/feeds'
import { MEMORY_BG, loadRail, type RailItem } from '../lib/social'
import { useAsync } from '../lib/hooks'
import { Avatar, useSigned } from '../ui'
import { FollowButton } from './discover/FollowButton'
import { VerifiedBadge } from './VerifiedBadge'
import type { Post } from '../lib/types'

/**
 * Suggestion rails dropped between Home posts, the way other feeds mix in "Suggested for you":
 * people to follow, suggested reels, memories about to expire, plans near you and artists.
 * Every rail is real data; one with nothing to show (or a failed load) renders nothing, so the feed simply carries on.
 */
export type SuggestionKind = 'people' | 'reels' | 'memories' | 'plans' | 'artists'
export const SUGGESTION_KINDS: SuggestionKind[] = ['people', 'reels', 'memories', 'plans', 'artists']

export function FeedSuggestion({ kind }: { kind: SuggestionKind }) {
  switch (kind) {
    case 'people': return <PeopleRail />
    case 'reels': return <ReelsRail />
    case 'memories': return <MemoriesRail />
    case 'plans': return <PlansRail />
    case 'artists': return <ArtistsRail />
  }
}

function Rail({ title, seeAll, label, children }: { title: string; seeAll?: string; label?: string; children: React.ReactNode }) {
  return (
    <section className="fsug" aria-label={label ?? title}>
      <div className="fsug-h">
        <h2 className="t-section">{title}{seeAll && <> · <Link to={seeAll} className="fsug-all">See all</Link></>}</h2>
      </div>
      <ul className="fsug-list">{children}</ul>
    </section>
  )
}

const quiet = <T,>(p: Promise<T>) => p.catch(() => null)

// ---------------------------------------------------------------- people
const why = (s: Suggestion) => s.follows_me ? 'Follows you' : s.mutual > 0 ? `${s.mutual} mutual ${s.mutual === 1 ? 'friend' : 'friends'}` : s.shared.length ? `Also into ${s.shared.slice(0, 2).join(' & ')}` : 'Suggested for you'

function PeopleRail() {
  const { uid } = useAuth()
  const list = useAsync(async () => shuffled((await quiet(loadSuggestions(20))) ?? []), [uid])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const rows = (list.data ?? []).filter(s => !hidden.has(s.id)).slice(0, 10)
  if (!rows.length) return null
  return (
    <Rail title="Suggested for you" seeAll="/app/people" label="People suggested for you">
      {rows.map(s => {
        const name = s.display_name || s.username
        return (
          <li key={s.id} className="fsug-person">
            <button className="fsug-x" aria-label={`Hide ${name}`} onClick={() => setHidden(h => new Set(h).add(s.id))}><X size={18} /></button>
            <Link to={`/app/u/${s.username}`} className="fsug-person-link">
              <span className="fsug-face"><Avatar size="lg" path={s.avatar_path} uid={s.id} name={name} /></span>
              <span className="fsug-name clamp-1">{name}<VerifiedBadge profile={s} size={16} /></span>
              <span className="t-meta fsug-why clamp-2">{why(s)}</span>
            </Link>
            <FollowButton type="profile" id={s.id} following={false} size="md" idleText={s.follows_me ? 'Follow back' : 'Follow'} label={name} className="fsug-follow" />
          </li>
        )
      })}
    </Rail>
  )
}

// ---------------------------------------------------------------- reels
function ReelsRail() {
  const { uid } = useAuth()
  const list = useAsync(() => quiet(fetchPosts({ uid: uid!, reels: true })), [uid])
  const rows = (list.data ?? []).filter(p => p.author !== uid).slice(0, 10)
  if (!rows.length) return null
  return (
    <Rail title="Suggested reels" seeAll="/app/reels">
      {rows.map(p => <li key={p.id} className="fsug-tall"><ReelTile post={p} /></li>)}
    </Rail>
  )
}

function ReelTile({ post }: { post: Post }) {
  const m = post.post_media?.[0]
  const poster = useSigned(m?.poster_path ?? m?.display_path ?? null)
  const name = post.profiles.display_name || post.profiles.username
  return (
    <Link to={`/app/reels?start=${post.id}`} className="fsug-card" aria-label={`Reel by ${name}${post.body ? `: ${post.body.slice(0, 60)}` : ''}`}>
      <span className="fsug-art" style={poster ? { backgroundImage: `url(${poster})` } : undefined} aria-hidden />
      <span className="fsug-play" aria-hidden><Play size={16} fill="currentColor" /></span>
      <span className="fsug-cap">
        {post.body && <span className="clamp-2">{post.body}</span>}
        <span className="fsug-by clamp-1">{name}</span>
      </span>
    </Link>
  )
}

// ---------------------------------------------------------------- memories
/** Memories last a day, so the oldest live ones are the ones about to disappear. */
function MemoriesRail() {
  const { uid } = useAuth()
  const list = useAsync(() => quiet(loadRail()), [uid])
  const rows = [...(list.data ?? [])].filter(r => r.author.id !== uid).sort((a, b) => a.latest_at.localeCompare(b.latest_at)).slice(0, 10)
  if (!rows.length) return null
  return (
    <Rail title="Expiring memories">
      {rows.map(r => <li key={r.author.id} className="fsug-tall"><MemoryTile item={r} /></li>)}
    </Rail>
  )
}

function MemoryTile({ item }: { item: RailItem }) {
  const c = item.cover
  const photo = useSigned(c?.kind === 'photo' ? c.media_path : null)
  const vid = useSigned(c?.kind === 'video' ? c.media_path : null)
  const name = item.author.display_name || item.author.username
  return (
    <Link to={`/app/memories/${item.author.id}`} className="fsug-card" aria-label={`${name}: ${item.count} ${item.count === 1 ? 'memory' : 'memories'}`}>
      <span className="fsug-art" style={c?.kind === 'text' ? { background: MEMORY_BG[c.bg] ?? MEMORY_BG.violet } : photo ? { backgroundImage: `url(${photo})` } : undefined} aria-hidden>
        {c?.kind === 'video' && vid && <video src={`${vid}#t=0.1`} muted playsInline preload="metadata" />}
        {c?.kind === 'text' && <span className="fsug-quote clamp-4">{c.text_body}</span>}
      </span>
      <span className="fsug-ring-wrap">
        <span className={`fsug-ring${item.unseen ? ' new' : ''}`}><Avatar size="lg" path={item.author.avatar_path} uid={item.author.id} name={name} /></span>
        <span className="fsug-by clamp-1">{name}</span>
      </span>
    </Link>
  )
}

// ---------------------------------------------------------------- plans
function PlansRail() {
  const list = useAsync(async () => shuffled((await quiet(discoverEvents({ limit: 10 }))) ?? []), [])
  const rows = list.data ?? []
  if (!rows.length) return null
  return (
    <Rail title="Plans near you" seeAll="/app/discover?mode=events">
      {rows.map(e => <li key={e.id} className="fsug-tall"><PlanTile e={e} /></li>)}
    </Rail>
  )
}

function PlanTile({ e }: { e: DiscoverEvent }) {
  const cover = useSigned(e.cover_path)
  const where = e.venue || e.city || e.location
  return (
    <Link to={`/app/plans/${e.id}`} className="fsug-card fsug-plan" aria-label={`${e.title}, ${shortDate(e.starts_at, e.timezone)}${where ? `, ${where}` : ''}`}>
      <span className="fsug-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden />
      <span className="fsug-date" aria-hidden><CalendarDays size={14} /> {shortDate(e.starts_at, e.timezone)}</span>
      <span className="fsug-cap">
        <span className="fsug-by clamp-2">{e.title}</span>
        {where && <span className="clamp-1">{where}</span>}
        {e.friends_going > 0 ? <span className="clamp-1">{e.friends_going} {e.friends_going === 1 ? 'friend' : 'friends'} going</span> : e.going > 0 ? <span className="clamp-1">{e.going} going</span> : null}
      </span>
    </Link>
  )
}

// ---------------------------------------------------------------- artists
function ArtistsRail() {
  const list = useAsync(async () => shuffled((await quiet(discoverOrgs({ kinds: ['artist', 'creator'], limit: 16 }))) ?? []), [])
  const rows = (list.data ?? []).filter(o => !o.following).slice(0, 10)
  if (!rows.length) return null
  return (
    <Rail title="Artists you might like" seeAll="/app/discover" label="Artists suggested for you">
      {rows.map(o => <li key={o.id} className="fsug-person"><ArtistTile o={o} /></li>)}
    </Rail>
  )
}

function ArtistTile({ o }: { o: OrgCard }) {
  return (
    <>
      <Link to={`/app/pages/${o.slug}`} className="fsug-person-link">
        <span className="fsug-face"><Avatar size="lg" kind="org" path={o.avatar_path} name={o.name} /></span>
        <span className="fsug-name clamp-1">{o.name}</span>
        <span className="t-meta fsug-why clamp-2">{ORG_KIND_LABEL[o.kind] ?? o.kind}{o.followers > 0 ? ` · ${o.followers} ${o.followers === 1 ? 'follower' : 'followers'}` : ''}</span>
      </Link>
      <FollowButton type="organization" id={o.id} following={o.following} size="md" label={o.name} className="fsug-follow" />
    </>
  )
}
