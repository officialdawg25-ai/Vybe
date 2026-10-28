import { useEffect, useMemo, useState } from 'react'
import { Accessibility, EyeOff } from 'lucide-react'
import { holdSeats, money, seatMap, type SeatMapSeat } from '../../lib/tickets'
import { Sheet, Spinner, errMsg } from '../../ui'

/**
 * Choose seats on the plan, then hold them. The hold is made by the server (all or nothing, under row locks) and lasts a few
 * minutes; the countdown shown is the server's expiry. Nothing here decides availability: a seat someone took a moment ago
 * is refused when holding, and the plan reloads.
 */
export function SeatPicker({ eventId, type, onHeld, onClose }: {
  eventId: string; type: { id: string; name: string; price_cents: number; max_per_order: number }
  onHeld: (h: { seats: string[]; expires_at: string }) => void; onClose: () => void
}) {
  const [map, setMap] = useState<Awaited<ReturnType<typeof seatMap>> | undefined>(undefined)
  const [picked, setPicked] = useState<string[]>([])
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const load = () => seatMap(eventId).then(setMap, e => { setErr(errMsg(e)); setMap(null) })
  useEffect(() => { void load() }, [eventId])   // eslint-disable-line react-hooks/exhaustive-deps
  const zones = map?.types.find(t => t.id === type.id)?.zones ?? []
  const eligible = (s: SeatMapSeat) => !zones.length || (s.zone !== null && zones.includes(s.zone))
  const groups = useMemo(() => {
    const g = new Map<string, Map<string, SeatMapSeat[]>>()
    for (const s of map?.seats ?? []) {
      if (!eligible(s)) continue
      const sec = `${s.section}${s.block ? ` · Block ${s.block}` : ''}`
      if (!g.has(sec)) g.set(sec, new Map())
      const rows = g.get(sec)!; if (!rows.has(s.row)) rows.set(s.row, []); rows.get(s.row)!.push(s)
    }
    return g
  }, [map, zones.join()])   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (s: SeatMapSeat) => setPicked(p => p.includes(s.id) ? p.filter(x => x !== s.id) : p.length >= type.max_per_order ? p : [...p, s.id])
  const label = (s: SeatMapSeat) => `Section ${s.section}${s.block ? `, Block ${s.block}` : ''}${s.row ? `, Row ${s.row}` : ''}, Seat ${s.seat}`
  const hold = async () => {
    setBusy(true); setErr('')
    try { onHeld(await holdSeats(eventId, type.id, picked)) } catch (e) { setErr(errMsg(e)); setPicked([]); void load() } finally { setBusy(false) }
  }
  return (
    <Sheet title={`Choose seats · ${type.name}`} onClose={onClose}>
      {map === undefined ? <Spinner /> : map === null ? <p className="t-support">Seat choice is not available right now.</p> : (
        <div className="sp">
          <ul className="sp-legend" aria-label="Legend">
            <li><span className="sp-seat available" aria-hidden /> Available</li><li><span className="sp-seat picked" aria-hidden /> Your choice</li>
            <li><span className="sp-seat held" aria-hidden /> Being bought</li><li><span className="sp-seat sold" aria-hidden /> Sold</li>
            <li><Accessibility size={14} aria-hidden /> Accessible</li><li><EyeOff size={14} aria-hidden /> Restricted view</li>
          </ul>
          <p className="sp-stage" aria-hidden>STAGE</p>
          {[...groups].map(([sec, rows]) => (
            <section key={sec} className="sp-sec" aria-label={`Section ${sec}`}>
              <h3 className="t-name">Section {sec}</h3>
              {[...rows].map(([row, seats]) => (
                <div key={row} className="sp-row" role="group" aria-label={`Row ${row}`}>
                  <span className="sp-rowlab" aria-hidden>{row}</span>
                  {seats.map(s => {
                    const mine = picked.includes(s.id), free = s.state === 'available' || s.state === 'mine'
                    return (
                      <button key={s.id} type="button" className={`sp-seat ${mine ? 'picked' : s.state}`} disabled={!free || (!mine && picked.length >= type.max_per_order)}
                        aria-pressed={mine} aria-label={`${label(s)}${s.accessible ? ', accessible' : ''}${s.restricted_view ? ', restricted view' : ''}${free ? '' : `, ${s.state === 'held' ? 'being bought' : s.state}`}`}
                        onClick={() => toggle(s)}>
                        {s.accessible ? <Accessibility size={12} aria-hidden /> : s.restricted_view ? <EyeOff size={12} aria-hidden /> : s.seat.replace(/^0+/, '')}
                      </button>)
                  })}
                </div>))}
            </section>))}
          {!groups.size && <p className="t-support">No seats on the plan for this ticket type.</p>}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="sp-bar">
            <span>{picked.length ? <><b>{picked.length} seat{picked.length === 1 ? '' : 's'}</b> · {type.price_cents ? money(type.price_cents * picked.length) : 'Free'}</> : `Choose up to ${type.max_per_order}`}</span>
            <button className="btn primary" disabled={!picked.length || busy} onClick={() => void hold()}>{busy ? 'Holding…' : `Hold for ${map.hold_minutes} minutes`}</button>
          </div>
        </div>
      )}
    </Sheet>
  )
}

/** "9:41 left" from the server's expiry, ticking each second; calls onExpire once when it runs out. */
export function useCountdown(expiresAt: string | null, onExpire?: () => void) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (!expiresAt) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [expiresAt])
  const left = expiresAt ? Math.max(0, Date.parse(expiresAt) - now) : 0
  useEffect(() => { if (expiresAt && left === 0) onExpire?.() }, [expiresAt, left === 0])   // eslint-disable-line react-hooks/exhaustive-deps
  return expiresAt ? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : null
}
