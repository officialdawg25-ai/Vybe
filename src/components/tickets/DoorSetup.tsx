import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ScanLine, Trash2 } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { useAsync } from '../../lib/hooks'
import { utcToZonedLocal, zonedLocalToUtc } from '../../lib/format'
import { addStaff, removeStaff } from '../../lib/trust'
import {
  addGate, addSession, addZone, admissionDashboard, generateSeats, loadDoorSetup, parseRows, removeGate, removeSession, removeZone,
  revokeScanSession, setEventEntry, toggleLink, updateGate, updateStaff, updateTypeRules, type DoorSetup as Setup,
} from '../../lib/admission'
import { Field, errMsg, toast } from '../../ui'

const ZONE_KINDS = ['general', 'standing', 'seated', 'vip', 'vvip', 'lounge', 'backstage', 'accessible', 'table', 'other']

/**
 * Organiser setup for the door: entry times and postponement, zones, gates, sessions, what each ticket type admits to, seats,
 * the door team (role, gate, expiry) and live numbers. Every change is a row the database checks against the organiser's own
 * event; the door applies it on the next scan.
 */
export function DoorSetupPanel({ eventId }: { eventId: string }) {
  const s = useAsync(() => loadDoorSetup(eventId), [eventId])
  const [open, setOpen] = useState(false)
  if (s.loading && !s.data) return null
  if (s.data === null) return null                                  // server without migration 43: the older door team panel still works
  if (!s.data) return null
  const act = async (f: () => Promise<unknown>, done?: string) => { try { await f(); if (done) toast(done); s.reload() } catch (e) { toast(errMsg(e)) } }
  return (
    <section className="card door-setup" aria-labelledby="ds-h" style={{ marginBottom: 20 }}>
      <div className="row between">
        <h2 id="ds-h" className="t-section">Entry, gates &amp; seating</h2>
        <Link className="btn sm" to={`/app/scan/${eventId}`}><ScanLine size={16} aria-hidden /> Door scanner</Link>
      </div>
      <LiveNumbers eventId={eventId} />
      <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide setup' : 'Set up entry rules, gates, seats and door team'}</button>
      {open && <SetupBody setup={s.data} eventId={eventId} act={act} />}
    </section>
  )
}

function SetupBody({ setup, eventId, act }: { setup: Setup; eventId: string; act: (f: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const { uid } = useAuth()
  const ev = setup.event, tz = ev.timezone || 'Africa/Johannesburg'
  const loc = (iso: string | null) => (iso ? utcToZonedLocal(iso, tz) : '')
  const utc = (v: string) => (v ? zonedLocalToUtc(v, tz) : null)
  const [doors, setDoors] = useState(loc(ev.doors_open_at)); const [close, setClose] = useState(loc(ev.entry_closes_at))
  const [zone, setZone] = useState(''); const [zoneKind, setZoneKind] = useState('general')
  const [gate, setGate] = useState(''); const [gateGa, setGateGa] = useState(true)
  const [sName, setSName] = useState(''); const [sStart, setSStart] = useState(''); const [sEnd, setSEnd] = useState('')
  const [sec, setSec] = useState('A'); const [rows, setRows] = useState('A-F'); const [per, setPer] = useState(20); const [seatZone, setSeatZone] = useState('')
  const [who, setWho] = useState('')
  const [newStart, setNewStart] = useState('')
  return (
    <div className="ds-body">
      <h3 className="t-name">Entry times <span className="t-meta">({tz})</span></h3>
      <p className="t-meta">Leave empty to use the defaults: doors 6 hours before the start, entry until the end (or 12 hours after the start). Tickets are refused outside these times.</p>
      <form className="row ds-row" onSubmit={e => { e.preventDefault(); void act(() => setEventEntry(eventId, { doors_open_at: utc(doors), entry_closes_at: utc(close) }), 'Entry times saved') }}>
        <Field id="ds-doors" label="Doors open"><input id="ds-doors" type="datetime-local" className="input" value={doors} onChange={e => setDoors(e.target.value)} /></Field>
        <Field id="ds-close" label="Entry closes"><input id="ds-close" type="datetime-local" className="input" value={close} onChange={e => setClose(e.target.value)} /></Field>
        <button className="btn sm">Save</button>
      </form>
      {ev.status === 'postponed' ? (
        <form className="ds-postpone" onSubmit={e => { e.preventDefault(); if (!newStart) return; void act(() => setEventEntry(eventId, { status: 'active', starts_at: utc(newStart)! }), 'New date set — ticket holders were told and their tickets are valid for it') }}>
          <p className="error">Postponed: every scan is refused until you set the new date. Tickets stay valid for it.</p>
          <div className="row ds-row"><Field id="ds-new" label="New start"><input id="ds-new" type="datetime-local" className="input" value={newStart} onChange={e => setNewStart(e.target.value)} /></Field>
            <button className="btn sm" disabled={!newStart}>Set new date</button></div>
        </form>
      ) : ev.status === 'active' && (
        <button className="btn ghost sm" onClick={() => { if (confirm('Postpone this event? Entry is refused until you set a new date, and every ticket holder is told.')) void act(() => setEventEntry(eventId, { status: 'postponed' }), 'Postponed') }}>Postpone event…</button>
      )}

      <h3 className="t-name">Zones</h3>
      <ul className="ds-list">{setup.zones.map(z => <li key={z.id}><span className="grow">{z.name} <span className="t-meta">{z.kind}</span></span>
        <button className="icon-btn" aria-label={`Remove zone ${z.name}`} onClick={() => void act(() => removeZone(z.id))}><Trash2 size={16} /></button></li>)}</ul>
      <form className="row ds-row" onSubmit={e => { e.preventDefault(); void act(() => addZone(eventId, zone, zoneKind), 'Zone added').then(() => setZone('')) }}>
        <Field id="ds-zone" label="New zone"><input id="ds-zone" className="input" value={zone} maxLength={60} onChange={e => setZone(e.target.value)} placeholder="VVIP Lounge" /></Field>
        <Field id="ds-zkind" label="Kind"><select id="ds-zkind" className="input" value={zoneKind} onChange={e => setZoneKind(e.target.value)}>{ZONE_KINDS.map(k => <option key={k}>{k}</option>)}</select></Field>
        <button className="btn sm" disabled={!zone.trim()}>Add</button>
      </form>

      <h3 className="t-name">Gates</h3>
      <p className="t-meta">A gate takes the zones ticked. “General admission” lets in tickets that grant no zone; untick it for a VIP-only entrance.</p>
      <ul className="ds-list">{setup.gates.map(g => (
        <li key={g.id} className="ds-gate">
          <div className="row" style={{ width: '100%' }}><b className="grow">{g.name}</b>
            <button className="chip sm" aria-pressed={g.status === 'open'} onClick={() => void act(() => updateGate(g.id, { status: g.status === 'open' ? 'closed' : 'open' }))}>{g.status === 'open' ? 'Open' : 'Closed'}</button>
            <button className="icon-btn" aria-label={`Remove gate ${g.name}`} onClick={() => void act(() => removeGate(g.id))}><Trash2 size={16} /></button></div>
          <div className="ds-checks">
            <label><input type="checkbox" checked={g.admits_unzoned} onChange={e => void act(() => updateGate(g.id, { admits_unzoned: e.target.checked }))} /> General admission</label>
            {setup.zones.map(z => <label key={z.id}><input type="checkbox" checked={g.zones.includes(z.id)} onChange={e => void act(() => toggleLink('gate_zones', g.id, z.id, e.target.checked))} /> {z.name}</label>)}
          </div>
        </li>))}</ul>
      <form className="row ds-row" onSubmit={e => { e.preventDefault(); void act(() => addGate(eventId, gate, gateGa), 'Gate added').then(() => setGate('')) }}>
        <Field id="ds-gate" label="New gate"><input id="ds-gate" className="input" value={gate} maxLength={60} onChange={e => setGate(e.target.value)} placeholder="Gate A" /></Field>
        <label className="ds-inline"><input type="checkbox" checked={gateGa} onChange={e => setGateGa(e.target.checked)} /> General admission</label>
        <button className="btn sm" disabled={!gate.trim()}>Add</button>
      </form>

      <h3 className="t-name">Sessions <span className="t-meta">(multi-day or afternoon/evening)</span></h3>
      <ul className="ds-list">{setup.sessions.map(x => <li key={x.id}><span className="grow">{x.name} <span className="t-meta">{new Date(x.starts_at).toLocaleString(undefined, { timeZone: tz })} – {new Date(x.ends_at).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })}</span></span>
        <button className="icon-btn" aria-label={`Remove session ${x.name}`} onClick={() => void act(() => removeSession(x.id))}><Trash2 size={16} /></button></li>)}</ul>
      <form className="row ds-row" onSubmit={e => { e.preventDefault(); void act(() => addSession(eventId, sName, utc(sStart)!, utc(sEnd)!), 'Session added').then(() => { setSName(''); setSStart(''); setSEnd('') }) }}>
        <Field id="ds-sname" label="Name"><input id="ds-sname" className="input" value={sName} maxLength={60} onChange={e => setSName(e.target.value)} placeholder="Day 1" /></Field>
        <Field id="ds-sstart" label="Starts"><input id="ds-sstart" type="datetime-local" className="input" value={sStart} onChange={e => setSStart(e.target.value)} /></Field>
        <Field id="ds-send" label="Ends"><input id="ds-send" type="datetime-local" className="input" value={sEnd} onChange={e => setSEnd(e.target.value)} /></Field>
        <button className="btn sm" disabled={!sName.trim() || !sStart || !sEnd}>Add</button>
      </form>

      <h3 className="t-name">What each ticket admits to</h3>
      <p className="t-meta">VIP and VVIP are only what you tick here: the door never guesses from a name, colour or price.</p>
      {setup.types.map(t => (
        <div key={t.id} className="ds-type">
          <b>{t.name}</b>
          <div className="ds-checks">
            {setup.zones.map(z => <label key={z.id}><input type="checkbox" checked={t.zones.includes(z.id)} onChange={e => void act(() => toggleLink('ticket_type_zones', t.id, z.id, e.target.checked))} /> {z.name}</label>)}
            {!setup.zones.length && <span className="t-meta">No zones: plain general admission.</span>}
          </div>
          {setup.sessions.length > 0 && <div className="ds-checks"><span className="t-meta">Sessions:</span>
            {setup.sessions.map(x => <label key={x.id}><input type="checkbox" checked={t.sessions.includes(x.id)} onChange={e => void act(() => toggleLink('ticket_type_sessions', t.id, x.id, e.target.checked))} /> {x.name}</label>)}
            {!t.sessions.length && <span className="t-meta">(none ticked = whole event)</span>}</div>}
          <div className="row ds-row">
            <Field id={`ds-pol-${t.id}`} label="Entry"><select id={`ds-pol-${t.id}`} className="input" value={t.entry_policy} onChange={e => void act(() => updateTypeRules(t.id, { entry_policy: e.target.value as 'single' | 'reentry' }))}>
              <option value="single">Single entry</option><option value="reentry">Re-entry allowed (scan out and in)</option></select></Field>
            {t.entry_policy === 'reentry' && <Field id={`ds-max-${t.id}`} label="Max entries"><input id={`ds-max-${t.id}`} type="number" min={1} max={50} className="input" defaultValue={t.max_entries ?? ''}
              onBlur={e => void act(() => updateTypeRules(t.id, { max_entries: e.target.value ? Number(e.target.value) : null }))} /></Field>}
            <Field id={`ds-seat-${t.id}`} label="Seating"><select id={`ds-seat-${t.id}`} className="input" value={t.seating} onChange={e => void act(() => updateTypeRules(t.id, { seating: e.target.value as 'none' | 'reserved' }))}>
              <option value="none">General admission — no seat</option><option value="reserved">Reserved seat (assigned at purchase)</option></select></Field>
          </div>
        </div>))}

      <h3 className="t-name">Seats</h3>
      {setup.seats.length ? <p className="t-meta">{setup.seats.map(x => `Section ${x.section}: ${x.total}`).join(' · ')}</p> : <p className="t-meta">No seat plan. Reserved-seat tickets need seats here; any sold beyond it are held at the door for a supervisor.</p>}
      <form className="row ds-row" onSubmit={e => { e.preventDefault(); const r = parseRows(rows); if (!r.length) return toast('Rows like A-F or 1-12'); void act(async () => toast(`${await generateSeats(eventId, seatZone || null, sec, r, per)} seats added`)) }}>
        <Field id="ds-sec" label="Section"><input id="ds-sec" className="input" value={sec} maxLength={20} onChange={e => setSec(e.target.value)} /></Field>
        <Field id="ds-rows" label="Rows"><input id="ds-rows" className="input" value={rows} onChange={e => setRows(e.target.value)} placeholder="A-F" /></Field>
        <Field id="ds-per" label="Seats per row"><input id="ds-per" type="number" min={1} max={200} className="input" value={per} onChange={e => setPer(Number(e.target.value))} /></Field>
        {setup.zones.length > 0 && <Field id="ds-szone" label="Zone"><select id="ds-szone" className="input" value={seatZone} onChange={e => setSeatZone(e.target.value)}><option value="">—</option>{setup.zones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}</select></Field>}
        <button className="btn sm">Add seats</button>
      </form>

      <h3 className="t-name">Door team</h3>
      <p className="t-meta">Scanners can only scan this event (and only their gate, if you set one). Supervisors can also look up references and admit tickets held for review, which is recorded. Nobody on the door sees ticket codes, orders or money.</p>
      <ul className="ds-list">{setup.staff.map(m => (
        <li key={m.user_id} className="ds-staff">
          <span className="grow">{m.profiles?.display_name || m.profiles?.username} <span className="t-meta">@{m.profiles?.username}</span></span>
          <select className="input sm" aria-label="Role" value={m.role} onChange={e => void act(() => updateStaff(eventId, m.user_id, { role: e.target.value as 'scanner' | 'supervisor' }))}><option value="scanner">Scanner</option><option value="supervisor">Supervisor</option></select>
          {setup.gates.length > 0 && <select className="input sm" aria-label="Gate" value={m.gate_id ?? ''} onChange={e => void act(() => updateStaff(eventId, m.user_id, { gate_id: e.target.value || null }))}><option value="">Any gate</option>{setup.gates.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
          <input className="input sm" type="datetime-local" aria-label="Access ends" title="Access ends (optional)" defaultValue={loc(m.expires_at)} onBlur={e => void act(() => updateStaff(eventId, m.user_id, { expires_at: utc(e.target.value) }))} />
          <button className="icon-btn" aria-label={`Remove @${m.profiles?.username} from the door team`} onClick={() => void act(() => removeStaff(eventId, m.user_id))}><Trash2 size={16} /></button>
        </li>))}</ul>
      <form className="row ds-row" onSubmit={e => { e.preventDefault(); void act(() => addStaff(eventId, who, uid!), 'Added to the door team').then(() => setWho('')) }}>
        <Field id="ds-who" label="Add by username"><input id="ds-who" className="input" autoCapitalize="none" value={who} onChange={e => setWho(e.target.value)} /></Field>
        <button className="btn sm" disabled={!who.trim()}>Add</button>
      </form>
      {setup.gates.some(g => !g.admits_unzoned && !g.zones.length) && <p className="error">A gate takes neither general admission nor any zone, so it can never admit anyone.</p>}
      {setup.types.some(t => t.seating === 'reserved') && !setup.seats.length && <p className="error">A ticket type uses reserved seats but there is no seat plan yet.</p>}
    </div>
  )
}

/** Live door numbers (records only), refreshed every 15 seconds while the page is visible. */
function LiveNumbers({ eventId }: { eventId: string }) {
  const [d, setD] = useState<Awaited<ReturnType<typeof admissionDashboard>> | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    admissionDashboard(eventId).then(x => { if (live) setD(x) }, () => { if (live) setD(null) })
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') setTick(n => n + 1) }, 15000)
    return () => { live = false; window.clearInterval(t) }
  }, [eventId, tick])
  if (!d) return <p className="t-meta">No door activity yet.</p>
  const denied = Object.entries(d.by_decision).filter(([k]) => !['ACCEPTED', 'OK', 'EXITED', 'EXIT'].includes(k)).reduce((a, [, v]) => a + v, 0)
  return (
    <div className="ds-live">
      <div className="ds-stats">
        <div><b>{d.admitted}</b><span>admitted</span></div>
        <div><b>{d.issued}</b><span>tickets issued</span></div>
        <div><b>{d.inside_now}</b><span>inside now{d.capacity ? ` / ${d.capacity}` : ''}</span></div>
        <div><b>{denied}</b><span>refused scans</span></div>
      </div>
      {d.unseated > 0 && <p className="error">{d.unseated} reserved-seat ticket{d.unseated === 1 ? ' has' : 's have'} no seat yet.</p>}
      {d.by_gate.length > 0 && <p className="t-meta">{d.by_gate.map(g => `${g.gate}: ${g.admitted} in, ${g.denied} refused`).join(' · ')}</p>}
      {d.repeat_denials.length > 0 && <p className="t-meta">Refused 3+ times today: {d.repeat_denials.map(r => `${r.ref} (${r.attempts})`).join(', ')} — check with the holder before assuming fraud.</p>}
      {d.active_scanners.length > 0 && <ul className="ds-list">{d.active_scanners.map(s => (
        <li key={s.id}><span className="grow">{s.scanner} <span className="t-meta">{s.gate ?? 'all gates'} · {s.device} · seen {new Date(s.last_seen_at).toLocaleTimeString()}</span></span>
          <button className="btn ghost sm" onClick={() => { if (confirm(`Stop ${s.scanner}'s scanner session now?`)) revokeScanSession(s.id).then(() => { toast('Session stopped'); setTick(n => n + 1) }, e => toast(errMsg(e))) }}>Stop</button></li>))}</ul>}
    </div>
  )
}
