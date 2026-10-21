import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Compass, Music2, Plus, Ticket } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { VMark } from '../brand/Logo'
import { discoverEvents, discoverOrgs } from '../lib/discover'
import { useAsync } from '../lib/hooks'
import { MEMORY_BG, brandUrl, loadRail, musicCatalog, type RailItem } from '../lib/social'
import { Avatar, useSigned } from '../ui'
import { VerifiedBadge } from './VerifiedBadge'

/**
 * The stacked rail between the header and the composer. Each card is its own destination (own route):
 * Share a memory → /app/memories/new, Discover music → /app/music, Plans near you → Discover, My tickets → /app/tickets,
 * then everyone with a live public/friends memory — tap to watch, swipe the rail left to keep exploring.
 */
export function MemoryRail() {
  const { profile } = useAuth()
  const rail = useAsync(async () => { try { return await loadRail() } catch { return null } }, [])
  return (
    <nav className="mrail" aria-label="Memories and shortcuts">
      <ul className="mrail-list">
        <li className="mc-wrap" style={{ zIndex: 20 }}><ShareCard avatar={profile?.avatar_path} name={profile?.display_name || profile?.username || ''} /></li>
        <li className="mc-wrap" style={{ zIndex: 19 }}><MusicCard /></li>
        <li className="mc-wrap" style={{ zIndex: 18 }}><PlansCard city={profile?.location ?? undefined} /></li>
        <li className="mc-wrap" style={{ zIndex: 17 }}><Link to="/app/tickets" className="mc mc-tix"><span className="mc-ico"><Ticket size={20} aria-hidden /></span><span className="mc-label">My tickets</span></Link></li>
        {(rail.data ?? []).map((r, i) => <li key={r.author.id} className="mc-wrap" style={{ zIndex: 16 - Math.min(i, 15) }}><PersonCard item={r} /></li>)}
      </ul>
    </nav>
  )
}

function ShareCard({ avatar, name }: { avatar?: string | null; name: string }) {
  const url = useSigned(avatar)
  return (
    <Link to="/app/memories/new" className="mc mc-share" aria-label="Share a memory">
      <span className="mc-art" style={url ? { backgroundImage: `url(${url})` } : undefined}>
        {!url && <span className="mc-vybe" aria-hidden><VMark size={64} /></span>}
      </span>
      <span className="mc-plus" aria-hidden><Plus size={22} strokeWidth={3} /></span>
      <span className="mc-label dark">Share a memory</span>
      <span className="sr-only">{name}</span>
    </Link>
  )
}

/** Artist suggestions that fade in and out in sequence: real artists only (the VYBE library plus artist pages). */
function useArtists() {
  return useAsync(async () => {
    const [tracks, orgs] = await Promise.all([musicCatalog('foryou').catch(() => null), discoverOrgs({ kinds: ['artist', 'creator'], limit: 8 }).catch(() => null)])
    const seen = new Set<string>(), out: { name: string; art: string | null }[] = []
    for (const t of tracks ?? []) { const k = t.artist.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push({ name: t.artist, art: t.artwork_path ? brandUrl(t.artwork_path) : null }) } }
    for (const o of orgs ?? []) { const k = o.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push({ name: o.name, art: null }) } }
    return out.slice(0, 10)
  }, [])
}
function MusicCard() {
  const artists = useArtists()
  const list = artists.data ?? []
  const [i, setI] = useState(0)
  useEffect(() => {
    if (list.length < 2 || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return
    const t = setInterval(() => setI(x => (x + 1) % list.length), 3200)
    return () => clearInterval(t)
  }, [list.length])
  const cur = list[i % Math.max(list.length, 1)]
  return (
    <Link to="/app/music" className="mc mc-music" aria-label={cur ? `Discover music. Suggested artist: ${cur.name}` : 'Discover music'}>
      {list.map((a, k) => <span key={a.name} className={`mc-fade${k === i % list.length ? ' on' : ''}`} style={a.art ? { backgroundImage: `url(${a.art})` } : undefined} aria-hidden />)}
      <span className="mc-ico"><Music2 size={20} aria-hidden /></span>
      <span className="mc-label">{cur ? <><span className="mc-kicker">Discover music</span><span key={cur.name} className="mc-artist">{cur.name}</span></> : 'Discover music'}</span>
    </Link>
  )
}

function PlansCard({ city }: { city?: string }) {
  const next = useAsync(async () => { try { return (await discoverEvents({ limit: 1 }))?.[0] ?? null } catch { return null } }, [])
  const cover = useSigned(next.data?.cover_path)
  return (
    <Link to="/app/discover?mode=events" className="mc mc-near" aria-label="Plans near you">
      <span className="mc-fade on" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden />
      <span className="mc-ico">{next.data ? <CalendarDays size={20} aria-hidden /> : <Compass size={20} aria-hidden />}</span>
      <span className="mc-label">{next.data ? <><span className="mc-kicker">Plans near you</span><span className="mc-artist clamp-2">{next.data.title}</span></> : <>Plans near {city ? city.split(',')[0] : 'you'}</>}</span>
    </Link>
  )
}

function PersonCard({ item }: { item: RailItem }) {
  const c = item.cover
  const url = useSigned(c?.kind === 'photo' ? c.media_path : null)
  const vid = useSigned(c?.kind === 'video' ? c.media_path : null)
  const name = item.author.display_name || item.author.username
  return (
    <Link to={`/app/memories/${item.author.id}`} className="mc mc-person" aria-label={`${name}: ${item.count} ${item.count === 1 ? 'memory' : 'memories'}${item.unseen ? `, ${item.unseen} new` : ''}`}>
      <span className="mc-art" style={c?.kind === 'text' ? { background: MEMORY_BG[c.bg] ?? MEMORY_BG.violet } : url ? { backgroundImage: `url(${url})` } : undefined}>
        {c?.kind === 'video' && vid && <video src={`${vid}#t=0.1`} muted playsInline preload="metadata" aria-hidden />}
        {c?.kind === 'text' && <span className="mc-quote clamp-4">{c.text_body}</span>}
      </span>
      <span className={`mc-ring${item.unseen ? ' new' : ''}`}><Avatar size="sm" path={item.author.avatar_path} name={name} /></span>
      <span className="mc-label"><span className="clamp-2">{name}<VerifiedBadge profile={item.author} size={14} /></span></span>
    </Link>
  )
}
