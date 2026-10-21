import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, ChevronLeft, Compass, Music2, Ticket } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { VMark } from '../brand/Logo'
import { discoverEvents, discoverOrgs } from '../lib/discover'
import { useAsync } from '../lib/hooks'
import { MEMORY_BG, authorMemories, brandUrl, loadRail, musicCatalog, type RailItem } from '../lib/social'
import { Avatar, useSigned } from '../ui'
import { VerifiedBadge } from './VerifiedBadge'

/**
 * The rail between the header and the composer. It starts as a closed stack of cards (the front card with the others peeking
 * out behind it); one tap fans it out, and from then on each card is its own destination:
 * Share a memory / Your memory → the memory screens, Discover music → /app/music, Plans near you → Discover, My tickets → /app/tickets,
 * then everyone with a live public/friends memory. Swipe the opened rail to keep exploring; "Close" folds it back into a stack.
 */
export function MemoryRail() {
  const { profile, uid } = useAuth()
  // Errors are kept apart from "nothing to show": a failed request must not be read as "this person has no memory".
  const rail = useAsync(async () => { try { return await loadRail() } catch { return null } }, [])
  const mine = useAsync(async () => (uid ? authorMemories(uid) : []), [uid])
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const list = useRef<HTMLUListElement>(null)
  const first = useRef(true)
  // Opening starts at the front; closing must also return to the front, or the folded stack is drawn from wherever the reader
  // had scrolled to (the Close button sits at the far end), which looked like the rail had not closed.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    list.current?.scrollTo({ left: 0 })
    if (!open) list.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  // Memories expire while Home is open: re-check people when the tab comes back and every few minutes.
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') { rail.reload(); mine.reload(); setNow(Date.now()) } }
    const t = window.setInterval(again, 5 * 60_000)
    document.addEventListener('visibilitychange', again)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', again) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  /** While folded, any tap on the stack only opens it. */
  const guard = (e: MouseEvent) => { if (!open) { e.preventDefault(); e.stopPropagation(); setOpen(true) } }
  const people = rail.data ?? []
  const live = (mine.data ?? []).filter(m => new Date(m.expires_at).getTime() > now)
  const latest = live[live.length - 1]
  // Your own card flips back to "Share a memory" the moment your last memory expires, not on the next reload.
  const nextExpiry = live.reduce((t, m) => Math.min(t, new Date(m.expires_at).getTime()), Infinity)
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return
    const t = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(nextExpiry - Date.now() + 250, 0), 2 ** 31 - 1))
    return () => window.clearTimeout(t)
  }, [nextExpiry])
  const name = profile?.display_name || profile?.username || ''
  return (
    <nav className={`mrail${open ? ' open' : ' stacked'}`} aria-label="Memories and shortcuts">
      <ul ref={list} className="mrail-list" onClickCapture={guard}>
        <li className="mc-wrap" style={{ zIndex: 20 }}>
          {mine.loading && !mine.data
            ? <span className="mc mc-skel skeleton" aria-hidden />                       // neither state is claimed until we know
            : <ShareCard avatar={profile?.avatar_path} name={name} uid={uid} latest={mine.error ? undefined : latest} count={live.length} />}
        </li>
        <li className="mc-wrap" style={{ zIndex: 19 }}><MusicCard /></li>
        <li className="mc-wrap" style={{ zIndex: 18 }}><PlansCard city={profile?.location ?? undefined} /></li>
        <li className="mc-wrap" style={{ zIndex: 17 }}><Link to="/app/tickets" className="mc mc-tix"><span className="mc-ico"><Ticket size={20} aria-hidden /></span><span className="mc-label">My tickets</span></Link></li>
        {people.map((r, i) => <li key={r.author.id} className="mc-wrap" style={{ zIndex: 16 - Math.min(i, 15) }}><PersonCard item={r} /></li>)}
        {open && <li className="mc-wrap mc-close"><button type="button" className="mc-fold" onClick={() => setOpen(false)} aria-label="Close the rail"><ChevronLeft size={22} aria-hidden /><span>Close</span></button></li>}
      </ul>
      {!open && people.length > 0 && <span className="mrail-more" aria-hidden>+{people.length}</span>}
      <span className="sr-only" role="status">{open ? 'Memories opened. Press Escape or Close to fold them away.' : ''}</span>
    </nav>
  )
}

type Cover = { kind: 'photo' | 'video' | 'text'; media_path: string | null; text_body: string; bg: string } | null
/** Artwork for a memory card: a photo, a video frame or a coloured text card. */
function CoverArt({ c }: { c: Cover }) {
  const url = useSigned(c?.kind === 'photo' ? c.media_path : null)
  const vid = useSigned(c?.kind === 'video' ? c.media_path : null)
  return (
    <span className="mc-art" style={c?.kind === 'text' ? { background: MEMORY_BG[c.bg] ?? MEMORY_BG.violet } : url ? { backgroundImage: `url(${url})` } : undefined}>
      {c?.kind === 'video' && vid && <video src={`${vid}#t=0.1`} muted playsInline preload="metadata" aria-hidden />}
      {c?.kind === 'text' && <span className="mc-quote clamp-4">{c.text_body}</span>}
    </span>
  )
}

/** "Share a memory" until you have a live memory of your own; then it shows it (tap to watch), with its own ring. */
function ShareCard({ avatar, name, uid, latest, count }: { avatar?: string | null; name: string; uid: string | null; latest?: { kind: 'photo' | 'video' | 'text'; media_path: string | null; text_body: string; bg: string; seen: boolean }; count: number }) {
  const url = useSigned(avatar)
  if (latest && uid) {
    return (
      <Link to={`/app/memories/${uid}`} className="mc mc-person mc-own" aria-label={`Your memory: ${count} live ${count === 1 ? 'memory' : 'memories'}`}>
        <CoverArt c={latest} />
        <span className="mc-ring new"><Avatar size="sm" path={avatar} name={name} /></span>
        <span className="mc-label"><span className="clamp-2">Your memory{count > 1 ? ` · ${count}` : ''}</span></span>
      </Link>
    )
  }
  return (
    <Link to="/app/memories/new" className="mc mc-share" aria-label="Share a memory">
      <span className="mc-art" style={url ? { backgroundImage: `url(${url})` } : undefined}>
        {!url && <span className="mc-vybe" aria-hidden><VMark size={64} /></span>}
      </span>
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
  const name = item.author.display_name || item.author.username
  return (
    <Link to={`/app/memories/${item.author.id}`} className="mc mc-person" aria-label={`${name}: ${item.count} ${item.count === 1 ? 'memory' : 'memories'}${item.unseen ? `, ${item.unseen} new` : ''}`}>
      <CoverArt c={item.cover} />
      <span className={`mc-ring${item.unseen ? ' new' : ''}`}><Avatar size="sm" path={item.author.avatar_path} uid={item.author.id} name={name} /></span>
      <span className="mc-label"><span className="clamp-2">{name}<VerifiedBadge profile={item.author} size={14} /></span></span>
    </Link>
  )
}
