import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, Bookmark, BookmarkCheck, MapPin, Sparkles, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { ORG_KIND_LABEL, setSaved, shortDate } from '../lib/discover'
import { dismissSuggestion, reasonText, type SuggestedArtist, type SuggestedEvent, type SuggestedPerson, type SuggestionKind, type Suggestions } from '../lib/suggestions'
import { isVerified } from '../lib/social'
import { Avatar, errMsg, toast, useSigned } from '../ui'
import { FollowButton } from './discover/FollowButton'

/**
 * A rail of suggestions between feed posts: events, artists or people. Each card says why it is there (its reason from the
 * server), offers the one natural action (save, follow) and "Not interested", which removes it here and on every device.
 */
export function SuggestionRail<T extends { id: string }>({ kind, title, items, render }: { kind: SuggestionKind; title: string; items: T[]; render: (item: T) => React.ReactNode }) {
  const [gone, setGone] = useState<Set<string>>(new Set())
  const shown = items.filter(i => !gone.has(i.id))
  if (!shown.length) return null
  const dismiss = async (id: string) => {
    setGone(g => new Set(g).add(id))
    try { await dismissSuggestion(kind, id) } catch (e) { setGone(g => { const n = new Set(g); n.delete(id); return n }); toast(errMsg(e)) }
  }
  return (
    <section className="sg" aria-label={title}>
      <h2 className="sg-title"><Sparkles size={16} aria-hidden /> {title}</h2>
      <ul className={`hscroll ${kind === 'profile' ? 'people' : kind === 'org' ? 'org-rail' : 'poster-rail'}`}>
        {shown.map(i => (
          <li key={i.id} className={kind === 'profile' ? 'person sg-card' : 'sg-card'}>
            {render(i)}
            <button className="sg-x" aria-label="Not interested" title="Not interested" onClick={() => void dismiss(i.id)}><X size={14} aria-hidden /></button>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SuggestedEventCard({ e }: { e: SuggestedEvent }) {
  const { uid } = useAuth()
  const cover = useSigned(e.cover_path)
  const [saved, setOn] = useState(false), [busy, setBusy] = useState(false)
  const where = e.format === 'online' ? 'Online' : [e.venue, e.city].filter(Boolean).join(', ') || 'Location to be announced'
  const at = new Date(e.starts_at)
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: e.timezone }).format(at)
  const mon = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: e.timezone }).format(at)
  const save = async () => {
    if (!uid || busy) return
    setBusy(true); setOn(!saved)
    try { await setSaved(e.id, uid, !saved); toast(saved ? 'Removed from saved' : 'Saved to your plans') } catch (err) { setOn(saved); toast(errMsg(err)) } finally { setBusy(false) }
  }
  return (
    <>
      <Link to={`/app/plans/${e.id}`} className="poster rail" aria-label={`${e.title}, ${shortDate(e.starts_at, e.timezone)}, ${where}. ${reasonText(e.reason)}`}>
        <div className="poster-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
          {!cover && <span className="poster-initial" aria-hidden>{e.title.charAt(0).toUpperCase()}</span>}
          <span className="poster-shade" aria-hidden />
          <span className="poster-date" aria-hidden><b>{day}</b><span>{mon}</span></span>
          <span className="poster-over">
            {e.category_label && <span className="poster-cat">{e.category_label}</span>}
            <span className="poster-title clamp-2">{e.title}</span>
            <span className="poster-line clamp-1"><MapPin size={12} aria-hidden /> {where}</span>
            <span className="sg-why clamp-1">{reasonText(e.reason)}</span>
          </span>
        </div>
      </Link>
      <button className={`btn sm sg-act${saved ? '' : ' primary'}`} aria-pressed={saved} disabled={busy} onClick={save}>
        {saved ? <><BookmarkCheck size={16} aria-hidden /> Saved</> : <><Bookmark size={16} aria-hidden /> Save</>}
      </button>
    </>
  )
}

export function SuggestedArtistCard({ a }: { a: SuggestedArtist }) {
  const logo = useSigned(a.avatar_path)
  return (
    <article className="org-tile">
      <Link to={`/app/pages/${a.slug}`} className="org-tile-art" style={logo ? { backgroundImage: `url(${logo})` } : undefined} aria-label={`${a.name}, ${ORG_KIND_LABEL[a.kind] ?? a.kind}. ${reasonText(a.reason)}`}>
        {!logo && <span className="poster-initial" aria-hidden>{a.name.charAt(0).toUpperCase()}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="poster-over">
          <span className="poster-cat">{ORG_KIND_LABEL[a.kind] ?? a.kind}</span>
          <span className="poster-title clamp-2">{a.name}{a.verified && <BadgeCheck size={15} aria-label="Verified by VYBE" style={{ marginLeft: 4, verticalAlign: '-2px' }} />}</span>
          <span className="sg-why clamp-1">{reasonText(a.reason)}</span>
        </span>
      </Link>
      <div className="org-tile-act"><FollowButton type="organization" id={a.id} following={false} label={a.name} /></div>
    </article>
  )
}

export function SuggestedPersonCard({ p }: { p: SuggestedPerson }) {
  const name = p.display_name || p.username
  return (
    <>
      <Link to={`/app/u/${p.username}`} className="person-link">
        <Avatar path={p.avatar_path} name={name} size="lg" uid={p.id} />
        <span className="t-name clamp-1">{name}{isVerified(p) && <BadgeCheck size={14} aria-label="VYBE Verified" style={{ marginLeft: 3, verticalAlign: '-2px' }} />}</span>
        <span className="t-meta clamp-1">{reasonText(p.reason)}</span>
      </Link>
      <FollowButton type="profile" id={p.id} following={false} label={name} />
    </>
  )
}

/** One rail by kind; the default export so Home can load this file only once its feed is on screen. */
export default function FeedRail({ which, data }: { which: 'events' | 'artists' | 'people'; data: Suggestions }) {
  if (which === 'events') return <SuggestionRail kind="event" title="Events for you" items={data.events} render={e => <SuggestedEventCard e={e} />} />
  if (which === 'artists') return <SuggestionRail kind="org" title="Artists you might like" items={data.artists} render={a => <SuggestedArtistCard a={a} />} />
  return <SuggestionRail kind="profile" title="People you may know" items={data.people} render={p => <SuggestedPersonCard p={p} />} />
}
