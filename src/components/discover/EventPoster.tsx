import { Link } from 'react-router-dom'
import { BadgeCheck, MapPin, Radio, Wifi } from 'lucide-react'
import { Avatar, useSigned } from '../../ui'
import { money } from '../../lib/tickets'
import { shortDate, type DiscoverEvent } from '../../lib/discover'

/**
 * Poster-style event card: the uploaded artwork fills the card and everything you need sits on it (date, title, where,
 * who runs it, price, friends going), over a shade dark enough to read on any picture. Everything shown is backed by the
 * record; with no artwork the card uses a colour field and the event's initial.
 */
export function EventPoster({ e, index, rail = false }: { e: DiscoverEvent; index?: number; rail?: boolean }) {
  const cover = useSigned(e.cover_path)
  const where = e.format === 'online' ? 'Online' : [e.venue, e.city].filter(Boolean).join(', ') || e.location || 'Location to be announced'
  const price = e.price_from_cents ?? (e.price_cents && e.price_cents > 0 ? e.price_cents : null)
  const free = !e.has_tickets && !(e.price_cents && e.price_cents > 0)
  const first = e.friend_avatars?.[0]
  const by = e.org?.name ?? (e.host ? e.host.display_name || `@${e.host.username}` : null)
  const at = new Date(e.starts_at)
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: e.timezone }).format(at)
  const mon = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: e.timezone }).format(at)
  return (
    <Link to={`/app/plans/${e.id}`} className={`poster${rail ? ' rail' : ''}`} aria-label={`${e.title}, ${shortDate(e.starts_at, e.timezone)}, ${where}`}>
      <div className="poster-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {!cover && <span className="poster-initial" aria-hidden>{e.title.charAt(0).toUpperCase()}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="poster-date" aria-hidden><b>{day}</b><span>{mon}</span></span>
        {index != null && <span className="poster-index" aria-hidden>{String.fromCharCode(65 + index)}</span>}
        {e.live && <span className="pill-live"><Radio size={12} aria-hidden /> LIVE</span>}
        {!e.live && e.format !== 'in_person' && <span className="pill-fmt"><Wifi size={12} aria-hidden /> {e.format === 'online' ? 'Online' : 'Hybrid'}</span>}
        <span className="poster-over">
          {e.category_label && <span className="poster-cat">{e.category_label}</span>}
          <span className="poster-title clamp-2">{e.title}</span>
          {e.artists.length > 0 && <span className="poster-line clamp-1">{e.artists.join(' · ')}</span>}
          <span className="poster-line clamp-1"><MapPin size={12} aria-hidden /> {where}{e.distance_km != null ? ` · ${e.distance_km < 1 ? '<1' : Math.round(e.distance_km)} km` : ''}</span>
          {by && <span className="poster-by clamp-1">by {by}{e.org?.verified && <BadgeCheck size={12} aria-label="Verified" />}</span>}
          {e.friends_going > 0 && first && (
            <span className="poster-friends"><Avatar size="sm" path={first.avatar_path} name={first.display_name || first.username} /><span className="clamp-1">{e.friends_going === 1 ? `${first.display_name || first.username} is going` : `${first.display_name || first.username} +${e.friends_going - 1} going`}</span></span>
          )}
          <span className="poster-foot"><b>{free ? 'Free' : price != null ? `From ${money(price)}` : 'See details'}</b>{e.source === 'external' && e.source_name ? ` · via ${e.source_name}` : e.followed ? ' · Following' : ''}</span>
        </span>
      </div>
    </Link>
  )
}
