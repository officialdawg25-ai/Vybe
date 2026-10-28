import { Link } from 'react-router-dom'
import { artStyle, useReadyImage } from '../lib/imgCache'
import { formatPrice } from '../lib/format'
import { shortDate } from '../lib/discover'
import { useSigned } from '../ui'
import type { EventRow } from '../lib/types'

/** A plan as a poster: the artwork stands alone with its date; the words (state, title, @host, place, price) are underneath. */
export function PlanCard({ e, rsvp }: { e: EventRow & { profiles?: { username: string } | null }; rsvp?: string }) {
  const signed = useSigned(e.cover_path)
  const ok = useReadyImage(signed)
  const at = new Date(e.starts_at)
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: e.timezone }).format(at)
  const mon = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: e.timezone }).format(at)
  const state = e.status === 'draft' ? 'Draft · only you' : rsvp === 'going' ? 'You’re going' : rsvp === 'invited' ? 'You’re invited' : rsvp === 'maybe' ? 'Interested' : e.visibility === 'invite' ? 'Invite only' : e.visibility === 'friends' ? 'Friends' : null
  const price = formatPrice(e.price_cents, e.currency)
  return (
    <Link to={`/app/plans/${e.id}`} className="poster" aria-label={`${e.title}, ${shortDate(e.starts_at, e.timezone)}${e.location ? `, ${e.location}` : ''}`}>
      <div className="poster-art" style={artStyle(signed, ok)}>
        {!ok && <span className="poster-initial" aria-hidden>{e.title.charAt(0).toUpperCase()}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="poster-date" aria-hidden><b>{day}</b><span>{mon}</span></span>
        <span className="poster-over">
          {state && <span className="poster-cat">{state}</span>}
          <span className="poster-title clamp-2">{e.title}</span>
          <span className="poster-line clamp-1">{e.location || 'Location to be announced'}</span>
          <span className="poster-foot"><b>{price}</b></span>
        </span>
      </div>
      {e.profiles?.username && <span className="pc by-only"><span className="pc-by clamp-1">by @{e.profiles.username}</span></span>}
    </Link>
  )
}
