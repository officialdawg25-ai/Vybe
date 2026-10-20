import { Link } from 'react-router-dom'
import { CalendarDays, MapPin, Radio, Wifi } from 'lucide-react'
import { Avatar, useSigned } from '../../ui'
import { money } from '../../lib/tickets'
import { shortDate, type DiscoverEvent } from '../../lib/discover'

/** Poster-style event tile: artwork first, then date, title and where. Everything shown is backed by the record. */
export function EventPoster({ e, index, rail = false }: { e: DiscoverEvent; index?: number; rail?: boolean }) {
  const cover = useSigned(e.cover_path)
  const where = e.format === 'online' ? 'Online' : [e.venue, e.city].filter(Boolean).join(', ') || e.location || 'Location to be announced'
  const price = e.price_from_cents ?? (e.price_cents && e.price_cents > 0 ? e.price_cents : null)
  const free = !e.has_tickets && !(e.price_cents && e.price_cents > 0)
  const first = e.friend_avatars?.[0]
  return (
    <Link to={`/app/plans/${e.id}`} className={`poster${rail ? ' rail' : ''}`}>
      <div className="poster-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {!cover && <span className="poster-initial" aria-hidden>{e.title.charAt(0).toUpperCase()}</span>}
        {index != null && <span className="poster-index" aria-hidden>{String.fromCharCode(65 + index)}</span>}
        {e.live && <span className="pill-live"><Radio size={12} aria-hidden /> LIVE</span>}
        {!e.live && e.format !== 'in_person' && <span className="pill-fmt"><Wifi size={12} aria-hidden /> {e.format === 'online' ? 'Online' : 'Hybrid'}</span>}
      </div>
      <span className="poster-date"><CalendarDays size={14} aria-hidden /> {shortDate(e.starts_at, e.timezone)}</span>
      <span className="poster-title clamp-2">{e.title}</span>
      {e.artists.length > 0 && <span className="t-meta clamp-1">{e.artists.join(' · ')}</span>}
      <span className="t-meta clamp-1"><MapPin size={12} aria-hidden /> {where}{e.distance_km != null ? ` · ${e.distance_km < 1 ? '<1' : Math.round(e.distance_km)} km` : ''}</span>
      {e.friends_going > 0 && first && (
        <span className="poster-friends"><Avatar size="sm" path={first.avatar_path} name={first.display_name || first.username} /><span className="t-meta clamp-1">{e.friends_going === 1 ? `${first.display_name || first.username} is going` : `${first.display_name || first.username} +${e.friends_going - 1} going`}</span></span>
      )}
      <span className="t-meta poster-foot"><b>{free ? 'Free' : price != null ? `From ${money(price)}` : 'See details'}</b>{e.source === 'external' && e.source_name ? ` · via ${e.source_name}` : e.followed ? ' · Following' : ''}</span>
    </Link>
  )
}
