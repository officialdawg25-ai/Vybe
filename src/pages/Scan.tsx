import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { formatEventTime } from '../lib/format'
import { DoorScanner } from '../components/tickets/DoorScanner'
import { Empty, ErrorState, Spinner } from '../ui'

/** /app/scan/:eventId — the door screen for an event's hosts and the door staff they added. The server checks both. */
export default function Scan() {
  const { eventId } = useParams()
  useEffect(() => { document.title = 'Door check-in · VYBE' }, [])
  const ev = useAsync(async () => {
    const [{ data, error }, allowed] = await Promise.all([
      supabase.from('events').select('id,title,starts_at,timezone').eq('id', eventId!).maybeSingle(),
      supabase.rpc('can_scan_event', { eid: eventId! }),
    ])
    if (error) throw error
    return data ? { ...(data as { id: string; title: string; starts_at: string; timezone: string }), allowed: allowed.error ? null : Boolean(allowed.data) } : null
  }, [eventId])
  if (ev.loading) return <Spinner />
  if (ev.error) return <ErrorState message={ev.error} onRetry={ev.reload} />
  if (!ev.data) return <Empty title="Event not found" action={<Link className="btn" to="/app/tickets">Back</Link>} />
  if (ev.data.allowed === false) return <Empty title="You are not on the door team" action={<Link className="btn" to={`/app/plans/${ev.data.id}`}>Open the event</Link>}>Ask the host to add you as door staff for this event.</Empty>
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Link className="icon-btn" to={`/app/plans/${ev.data.id}`} aria-label="Back to the event"><ArrowLeft size={22} /></Link>
        <div><h1 className="t-title">Door check-in</h1><p className="t-meta">{ev.data.title} · {formatEventTime(ev.data.starts_at, ev.data.timezone)}</p></div></div>
      <DoorScanner eventId={ev.data.id} />
    </>
  )
}
