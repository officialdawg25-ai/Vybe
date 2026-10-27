import { Link } from 'react-router-dom'
import { BadgeCheck, Radio, Wifi } from 'lucide-react'
import { useSigned } from '../../ui'
import { artStyle, useReadyImage } from '../../lib/imgCache'
import { money } from '../../lib/tickets'
import { shortDate, type DiscoverEvent } from '../../lib/discover'

/**
 * Poster-style event card: the artwork stands alone (only the date and a live/online tag sit on it) and the words go underneath:
 * category, title, who runs it (@handle), where, price and how many are going. Names stay on the event page, where each person's
 * privacy choice applies. Everything shown is backed by the record; with no artwork the card uses a colour field and the initial.
 */
export function EventPoster({ e, index, rail = false }: { e: DiscoverEvent; index?: number; rail?: boolean }) {
  const signed = useSigned(e.cover_path)
  const ok = useReadyImage(signed)
  const cover = ok ? signed : null
  const where = e.format === 'online' ? 'Online' : [e.venue, e.city].filter(Boolean).join(', ') || e.location || 'Location to be announced'
  const price = e.price_from_cents ?? (e.price_cents && e.price_cents > 0 ? e.price_cents : null)
  const free = !e.has_tickets && !(e.price_cents && e.price_cents > 0)
  const by = e.org ? `@${e.org.slug}` : e.host ? `@${e.host.username}` : null
  const at = new Date(e.starts_at)
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: e.timezone }).format(at)
  const mon = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: e.timezone }).format(at)
  return (
    <Link to={`/app/plans/${e.id}`} className={`poster${rail ? ' rail' : ''}`} aria-label={`${e.title}, ${shortDate(e.starts_at, e.timezone)}, ${where}${e.going ? `, ${e.going} going` : ''}`}>
      <div className="poster-art" style={artStyle(signed, ok)}>
        {!cover && <span className="poster-initial" aria-hidden>{e.title.charAt(0).toUpperCase()}</span>}
        <span className="poster-date" aria-hidden><b>{day}</b><span>{mon}</span></span>
        {index != null && <span className="poster-index" aria-hidden>{String.fromCharCode(65 + index)}</span>}
        {e.live && <span className="pill-live"><Radio size={12} aria-hidden /> LIVE</span>}
        {!e.live && e.format !== 'in_person' && <span className="pill-fmt"><Wifi size={12} aria-hidden /> {e.format === 'online' ? 'Online' : 'Hybrid'}</span>}
      </div>
      <span className="pc">
        {e.category_label && <span className="pc-kicker">{e.category_label}</span>}
        <span className="pc-title clamp-2">{e.title}</span>
        {by && <span className="pc-by clamp-1">by {by}{e.org?.verified && <BadgeCheck size={13} aria-label="Verified" />}</span>}
        <span className="pc-meta clamp-1">{where}{e.distance_km != null ? ` · ${e.distance_km < 1 ? '<1' : Math.round(e.distance_km)} km` : ''}</span>
        <span className="pc-meta clamp-1"><b>{free ? 'Free' : price != null ? `From ${money(price)}` : 'See details'}</b>{e.going > 0 ? ` · ${e.going} going` : ''}</span>
      </span>
    </Link>
  )
}
