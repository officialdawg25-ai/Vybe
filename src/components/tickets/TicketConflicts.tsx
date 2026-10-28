import { Link } from 'react-router-dom'
import { useAsync } from '../../lib/hooks'
import { myConflicts } from '../../lib/admission'

/** Scheduling help only: the viewer's other tickets that overlap this event. It never changes whether any ticket admits. */
export function TicketConflicts({ eventId }: { eventId: string }) {
  const c = useAsync(() => myConflicts(eventId), [eventId])
  if (!c.data?.length) return null
  return (
    <p className="notice" role="status" style={{ marginBottom: 12 }}>
      You have another ticketed event at the same time: {c.data.map((x, i) => <span key={x.id}>{i > 0 && ', '}<Link to={`/app/plans/${x.id}`}>{x.title}</Link></span>)}. Both tickets stay valid.
    </p>
  )
}
