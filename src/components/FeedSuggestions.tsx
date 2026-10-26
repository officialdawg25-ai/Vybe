import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Play, Radio, UsersRound, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { loadSuggestions, type Suggestion } from '../pages/People'
import { discoverEvents, discoverLive, discoverOrgs, shortDate, ORG_KIND_LABEL, type DiscoverEvent, type LiveItem, type OrgCard } from '../lib/discover'
import { fetchPosts } from '../lib/posts'
import { shuffled } from '../lib/feeds'
import { MEMORY_BG, loadRail, type RailItem } from '../lib/social'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { Avatar, useSigned } from '../ui'
import { FollowButton } from './discover/FollowButton'
import { VerifiedBadge } from './VerifiedBadge'
import type { Community, Post } from '../lib/types'
import { dismissRanked, loadRanked, reasonText, type DismissKind, type Reason } from '../lib/suggestions'

/**
 * Suggestion rails dropped between Home posts, the way other feeds mix in "Suggested for you":
 * people to follow, suggested reels, memories about to expire, plans near you, artists, communities and upcoming lives.
 * Kept calm on purpose: Home shows only a few of them per visit, well apart (see railSlot), a rail needs at least
 * MIN_ITEMS real entries or it stays hidden, and the reader can hide a kind for a week from its header.
 */
export type SuggestionKind = 'people' | 'reels' | 'memories' | 'plans' | 'artists' | 'communities' | 'live'
export const SUGGESTION_KINDS: SuggestionKind[] = ['people', 'reels', 'memories', 'plans', 'artists', 'communities', 'live']
const MIN_ITEMS = 2, MAX_ITEMS = 8

// Hidden kinds live in this browser only (a per-reader convenience); storage may be unavailable, so every access is guarded.
const SNOOZE_KEY = 'vybe:home-sug-snooze', SNOOZE_MS = 7 * 864e5
function readSnoozes(): Record<string, number> { try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') ?? {} } catch { return {} } }
export function snoozedKinds(now = Date.now()): Set<string> {
  return new Set(Object.entries(readSnoozes()).filter(([, until]) => typeof until === 'number' && until > now).map(([k]) => k))
}
function snooze(kind: SuggestionKind) { try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ ...readSnoozes(), [kind]: Date.now() + SNOOZE_MS })) } catch { /* nothing to remember */ } }

// People, plans and artists come ranked by the database with the reason each was picked (feed_suggestions, migration 27).
// When that has too little (or the database is older), the rail falls back to the plain lists it used before.
type WithReason = { reason?: Reason }
type PersonItem = Suggestion & WithReason
type PlanItem = Pick<DiscoverEvent, 'id' | 'title' | 'starts_at' | 'timezone' | 'city' | 'venue' | 'cover_path' | 'going' | 'friends_going'> & { location?: string | null } & WithReason
type ArtistItem = Pick<OrgCard, 'id' | 'name' | 'slug' | 'kind' | 'avatar_path' | 'followers' | 'following'> & WithReason
type RailRows = { people: PersonItem[]; reels: Post[]; memories: RailItem[]; plans: PlanItem[]; artists: ArtistItem[]; communities: Community[]; live: LiveItem[] }

/** Where distance is measured from: only a place the member chose or has on their profile (Home sets it), never a default city. */
let rankPlace: { lat: number; lng: number } | null = null
export const setSuggestionPlace = (p: { lat: number; lng: number } | null) => { rankPlace = p ? { lat: p.lat, lng: p.lng } : null }
const ranked = (uid: string) => loadRanked(uid, rankPlace).catch(() => null)
const enough = <T,>(list: T[] | undefined) => (list && list.length >= MIN_ITEMS ? list : null)

/** What each rail shows, already filtered, so "does this rail have enough to show" is known before it is placed. */
const LOADERS: { [K in SuggestionKind]: (uid: string) => Promise<RailRows[K]> } = {
  people: async uid => enough((await ranked(uid))?.people.map(p => ({ ...p, follows_me: p.reason.code === 'follows_you', friend: false, mutual: p.reason.code === 'mutual_friends' ? p.reason.n ?? 0 : 0, shared: [] })))
    ?? shuffled((await loadSuggestions(20)) ?? []),
  reels: async uid => (await fetchPosts({ uid, reels: true })).filter(p => p.author !== uid),
  memories: async uid => ((await loadRail()) ?? []).filter(r => r.author.id !== uid).sort((a, b) => a.latest_at.localeCompare(b.latest_at)),
  plans: async uid => enough((await ranked(uid))?.events) ?? shuffled((await discoverEvents({ limit: 10 })) ?? []),
  artists: async uid => enough((await ranked(uid))?.artists.map(a => ({ ...a, following: false })))
    ?? shuffled(((await discoverOrgs({ kinds: ['artist', 'creator'], limit: 16 })) ?? []).filter(o => !o.following)),
  communities: async uid => {
    const [mine, all] = await Promise.all([
      supabase.from('community_members').select('community_id').eq('user_id', uid),
      supabase.from('communities').select('id,name,description,cover_path,topics,visibility').eq('visibility', 'public').order('created_at', { ascending: false }).limit(24),
    ])
    if (mine.error || all.error) return []
    const joined = new Set((mine.data ?? []).map(m => m.community_id as string))
    return shuffled(((all.data ?? []) as Community[]).filter(c => !joined.has(c.id)))
  },
  live: async () => ((await discoverLive()) ?? []).filter(l => l.status === 'scheduled' && l.can_watch),
}

// One answer per rail for a couple of minutes, shared by Home's placement check and the rail itself (no second request).
const CACHE_MS = 2 * 60_000
const cache = new Map<string, { at: number; p: Promise<unknown[]> }>()
function railData<K extends SuggestionKind>(kind: K, uid: string): Promise<RailRows[K]> {
  const key = `${uid}:${kind}`, hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p as Promise<RailRows[K]>
  const p = LOADERS[kind](uid).catch(() => [] as unknown as RailRows[K])   // a failed rail simply is not shown
  cache.set(key, { at: Date.now(), p })
  return p
}
function useRail<K extends SuggestionKind>(kind: K) {
  const { uid } = useAuth()
  return useAsync(() => railData(kind, uid!), [uid, kind])
}

/** Of these kinds (in order), the ones with enough real entries to be worth a rail. All are checked at once. */
export async function railsWithContent(kinds: SuggestionKind[], uid: string): Promise<SuggestionKind[]> {
  const ok = await Promise.all(kinds.map(k => railData(k, uid).then(rows => rows.length >= MIN_ITEMS)))
  return kinds.filter((_, i) => ok[i])
}

export function FeedSuggestion({ kind }: { kind: SuggestionKind }) {
  const [gone, setGone] = useState(false)
  if (gone) return null
  const hide = () => { snooze(kind); setGone(true) }
  switch (kind) {
    case 'people': return <PeopleRail hide={hide} />
    case 'reels': return <ReelsRail hide={hide} />
    case 'memories': return <MemoriesRail hide={hide} />
    case 'plans': return <PlansRail hide={hide} />
    case 'artists': return <ArtistsRail hide={hide} />
    case 'communities': return <CommunitiesRail hide={hide} />
    case 'live': return <LiveRail hide={hide} />
  }
}

/** "Not interested" is also remembered on the server (other devices, later visits). Best effort: the card is gone either way. */
const notInterested = (kind: DismissKind, id: string) => { void dismissRanked(kind, id).catch(() => {}) }

type Hide = { hide: () => void }
function Rail({ title, seeAll, label, hide, children }: { title: string; seeAll?: string; label?: string; children: React.ReactNode } & Hide) {
  return (
    <section className="fsug" aria-label={label ?? title}>
      <div className="fsug-h">
        <h2 className="fsug-title">{title}</h2>
        {seeAll && <Link to={seeAll} className="fsug-all">See all</Link>}
        <button className="fsug-hide" aria-label={`Hide ${title.toLowerCase()} for a week`} title="Hide for a week" onClick={hide}><X size={16} /></button>
      </div>
      <ul className="fsug-list">{children}</ul>
    </section>
  )
}

// ---------------------------------------------------------------- people
const why = (s: Suggestion) => s.follows_me ? 'Follows you' : s.mutual > 0 ? `${s.mutual} mutual ${s.mutual === 1 ? 'friend' : 'friends'}` : s.shared.length ? `Also into ${s.shared.slice(0, 2).join(' & ')}` : 'Suggested for you'

function PeopleRail({ hide }: Hide) {
  const list = useRail('people')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const rows = (list.data ?? []).filter(s => !hidden.has(s.id)).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Suggested for you" seeAll="/app/people" label="People suggested for you" hide={hide}>
      {rows.map(s => {
        const name = s.display_name || s.username
        return (
          <li key={s.id} className="fsug-person">
            <button className="fsug-x" aria-label={`Hide ${name}`} onClick={() => { setHidden(h => new Set(h).add(s.id)); notInterested('profile', s.id) }}><X size={18} /></button>
            <Link to={`/app/u/${s.username}`} className="fsug-person-link">
              <span className="fsug-face"><Avatar size="lg" path={s.avatar_path} uid={s.id} name={name} /></span>
              <span className="fsug-name clamp-1">{name}<VerifiedBadge profile={s} size={16} /></span>
              <span className="t-meta fsug-why clamp-2">{s.reason ? reasonText(s.reason) : why(s)}</span>
            </Link>
            <FollowButton type="profile" id={s.id} following={false} size="md" idleText={s.follows_me ? 'Follow back' : 'Follow'} label={name} className="fsug-follow" />
          </li>
        )
      })}
    </Rail>
  )
}

// ---------------------------------------------------------------- reels
function ReelsRail({ hide }: Hide) {
  const list = useRail('reels')
  const rows = (list.data ?? []).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Suggested reels" seeAll="/app/reels" hide={hide}>
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
function MemoriesRail({ hide }: Hide) {
  const list = useRail('memories')
  const rows = (list.data ?? []).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Expiring memories" hide={hide}>
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
function PlansRail({ hide }: Hide) {
  const list = useRail('plans')
  const rows = (list.data ?? []).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Plans near you" seeAll="/app/discover?mode=events" hide={hide}>
      {rows.map(e => <li key={e.id} className="fsug-tall"><PlanTile e={e} /></li>)}
    </Rail>
  )
}

function PlanTile({ e }: { e: PlanItem }) {
  const cover = useSigned(e.cover_path)
  const where = e.venue || e.city || e.location
  return (
    <Link to={`/app/plans/${e.id}`} className="fsug-card fsug-plan" aria-label={`${e.title}, ${shortDate(e.starts_at, e.timezone)}${where ? `, ${where}` : ''}`}>
      <span className="fsug-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden />
      <span className="fsug-date" aria-hidden><CalendarDays size={14} /> {shortDate(e.starts_at, e.timezone)}</span>
      <span className="fsug-cap">
        <span className="fsug-by clamp-2">{e.title}</span>
        {where && <span className="clamp-1">{where}</span>}
        {e.reason && e.reason.code !== 'upcoming' ? <span className="clamp-1">{reasonText(e.reason)}</span>
          : e.friends_going > 0 ? <span className="clamp-1">{e.friends_going} {e.friends_going === 1 ? 'friend' : 'friends'} going</span> : e.going > 0 ? <span className="clamp-1">{e.going} going</span> : null}
      </span>
    </Link>
  )
}

// ---------------------------------------------------------------- artists
function ArtistsRail({ hide }: Hide) {
  const list = useRail('artists')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const rows = (list.data ?? []).filter(o => !hidden.has(o.id)).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Artists you might like" seeAll="/app/discover?mode=artists" label="Artists suggested for you" hide={hide}>
      {rows.map(o => (
        <li key={o.id} className="fsug-person">
          <button className="fsug-x" aria-label={`Hide ${o.name}`} onClick={() => { setHidden(h => new Set(h).add(o.id)); notInterested('org', o.id) }}><X size={18} /></button>
          <ArtistTile o={o} />
        </li>))}
    </Rail>
  )
}

function ArtistTile({ o }: { o: ArtistItem }) {
  return (
    <>
      <Link to={`/app/pages/${o.slug}`} className="fsug-person-link">
        <span className="fsug-face"><Avatar size="lg" kind="org" path={o.avatar_path} name={o.name} /></span>
        <span className="fsug-name clamp-1">{o.name}</span>
        <span className="t-meta fsug-why clamp-2">{ORG_KIND_LABEL[o.kind] ?? o.kind}{o.reason ? ` · ${reasonText(o.reason)}` : o.followers > 0 ? ` · ${o.followers} ${o.followers === 1 ? 'follower' : 'followers'}` : ''}</span>
      </Link>
      <FollowButton type="organization" id={o.id} following={o.following} size="md" label={o.name} className="fsug-follow" />
    </>
  )
}

// ---------------------------------------------------------------- communities
/** Public communities you have not joined yet. */
function CommunitiesRail({ hide }: Hide) {
  const list = useRail('communities')
  const rows = (list.data ?? []).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Communities for you" seeAll="/app/communities" hide={hide}>
      {rows.map(c => <li key={c.id} className="fsug-tall"><CommunityTile c={c} /></li>)}
    </Rail>
  )
}

function CommunityTile({ c }: { c: Community }) {
  const cover = useSigned(c.cover_path)
  return (
    <Link to={`/app/communities/${c.id}`} className="fsug-card fsug-com" aria-label={`${c.name}${c.topics?.length ? `, ${c.topics.slice(0, 2).join(' and ')}` : ''}`}>
      <span className="fsug-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden>
        {!cover && <span className="fsug-initial">{c.name.charAt(0).toUpperCase()}</span>}
      </span>
      <span className="fsug-date" aria-hidden><UsersRound size={14} /> Community</span>
      <span className="fsug-cap">
        <span className="fsug-by clamp-2">{c.name}</span>
        {c.topics?.length ? <span className="clamp-1">{c.topics.slice(0, 2).join(' · ')}</span> : null}
      </span>
    </Link>
  )
}

// ---------------------------------------------------------------- upcoming lives
/** Streams scheduled ahead. Ones already live are in "Live now" at the top of Home, so they are not repeated here. */
function LiveRail({ hide }: Hide) {
  const list = useRail('live')
  const rows = (list.data ?? []).slice(0, MAX_ITEMS)
  if (rows.length < MIN_ITEMS) return null
  return (
    <Rail title="Coming up live" seeAll="/app/discover?mode=live" hide={hide}>
      {rows.map(l => <li key={l.id} className="fsug-tall"><LiveTile l={l} /></li>)}
    </Rail>
  )
}

function LiveTile({ l }: { l: LiveItem }) {
  const cover = useSigned(l.event.cover_path)
  const when = l.scheduled_for ? shortDate(l.scheduled_for, l.event.timezone) : null
  const by = l.org || l.host
  return (
    <Link to={`/app/live/${l.id}`} className="fsug-card" aria-label={`${l.title}${by ? ` by ${by}` : ''}${when ? `, ${when}` : ''}`}>
      <span className="fsug-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden />
      <span className="fsug-date fsug-live" aria-hidden><Radio size={14} /> {when ?? 'Soon'}</span>
      <span className="fsug-cap">
        <span className="fsug-by clamp-2">{l.title}</span>
        {by && <span className="clamp-1">{by}</span>}
      </span>
    </Link>
  )
}
