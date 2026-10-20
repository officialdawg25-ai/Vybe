import { Link } from 'react-router-dom'
import { Radio, Ticket } from 'lucide-react'
import { discoverLive, type LiveItem } from '../../lib/discover'
import { formatEventTime } from '../../lib/format'
import { useAsync } from '../../lib/hooks'
import { Empty, ErrorState, Spinner, useSigned } from '../../ui'

/** Event-related broadcasts only. A scheduled stream shows its start time and is never labelled LIVE until it actually starts. */
export function LiveList() {
  const list = useAsync(discoverLive, [])
  return list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data === null ? (
    <p className="notice" role="status">Live events need the latest database update.</p>
  ) : !list.data.length ? (
    <Empty title="No event broadcasts right now" action={<Link className="btn primary" to="/app/live">Everyday live streams are on Live</Link>}>When a concert, festival or community event streams, it appears here. Personal live streams stay on Home and the Live page.</Empty>
  ) : <ul className="live-list">{list.data.map(s => <LiveRow key={s.id} s={s} />)}</ul>
}

function LiveRow({ s }: { s: LiveItem }) {
  const cover = useSigned(s.event.cover_path)
  const live = s.status === 'live'
  return (
    <li className="live-row">
      <div className="live-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {live ? <span className="pill-live"><Radio size={12} aria-hidden /> LIVE</span> : <span className="pill-fmt">Scheduled</span>}
      </div>
      <div className="live-info">
        <span className="t-name clamp-2">{s.title}</span>
        <span className="t-meta clamp-1">{s.event.title}{s.org ? ` · ${s.org}` : s.host ? ` · ${s.host}` : ''}</span>
        <span className="t-meta clamp-1">{live ? `Started ${formatEventTime(s.started_at ?? s.event.starts_at, s.event.timezone)}` : `Starts ${formatEventTime(s.scheduled_for ?? s.event.starts_at, s.event.timezone)}`}{s.event.format === 'in_person' ? ` · ${[s.event.venue, s.event.city].filter(Boolean).join(', ')}` : ' · Online'}</span>
        <span className="t-meta">{s.access === 'ticket' ? <><Ticket size={12} aria-hidden /> Ticket holders only</> : 'Open to everyone'}{live && s.viewers ? ` · ${s.viewers} watching at peak` : ''}</span>
        <span className="row" style={{ marginTop: 6 }}>
          {s.can_watch ? <Link className="btn sm primary" to={`/app/live/${s.id}`}>{live ? 'Watch now' : 'Open waiting room'}</Link> : <Link className="btn sm primary" to={`/app/plans/${s.event.id}`}>Get a ticket</Link>}
          <Link className="btn sm ghost" to={`/app/plans/${s.event.id}`}>Event details</Link>
        </span>
      </div>
    </li>
  )
}
