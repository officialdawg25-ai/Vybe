import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Flashlight, LogOut, PauseCircle, ScanLine, Wifi, WifiOff, XCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { createFrameScanner } from '../../lib/qr'
import { playSound } from '../../lib/sounds'
import { formatEventTime } from '../../lib/format'
import {
  DECISION_UI, decisionDetail, deviceLabel, doorRole, endScanSession, normaliseCredential, overrideAdmission, scanTicket, startScanSession,
  type ScanOutcome, type ScanSession,
} from '../../lib/admission'
import { Field, Spinner, errMsg, toast } from '../../ui'

type Entry = { id: string; at: number; cred: string; mode: 'entry' | 'exit'; r: ScanOutcome }
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)

/**
 * The door. Staff pick the gate (and session) they are working, which opens a scanner session the organiser can see and
 * revoke. Every scan goes to the server, which decides against the ticket's own event, window, gate, seat and history and
 * redeems atomically. The screen shows ADMIT only when the server said so; a scan with no answer is NOT VERIFIED.
 */
export function DoorScanner({ eventId }: { eventId: string }) {
  const [sess, setSess] = useState<ScanSession | null>(null)
  if (!sess) return <StartSession eventId={eventId} onStart={setSess} />
  return <LiveDoor sess={sess} onEnd={() => setSess(null)} />
}

function StartSession({ eventId, onStart }: { eventId: string; onStart: (s: ScanSession) => void }) {
  const [opts, setOpts] = useState<{ role: string | null; myGate: string | null; gates: { id: string; name: string; status: string }[]; sessions: { id: string; name: string; starts_at: string }[] } | null | undefined>(undefined)
  const [gate, setGate] = useState(''); const [session, setSession] = useState(''); const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void (async () => {
      const [role, g, s] = await Promise.all([
        doorRole(eventId).catch(() => null),
        supabase.from('event_gates').select('id,name,status').eq('event_id', eventId).order('name'),
        supabase.from('event_sessions').select('id,name,starts_at').eq('event_id', eventId).order('starts_at'),
      ])
      if (!live) return
      if (role === null) { setOpts(null); return }
      const gates = (g.data ?? []) as { id: string; name: string; status: string }[]
      setOpts({ role: role.role, myGate: role.gate, gates, sessions: (s.data ?? []) as { id: string; name: string; starts_at: string }[] })
      setGate(role.gate ?? (gates.length === 1 ? gates[0].id : ''))
    })()
    return () => { live = false }
  }, [eventId])
  if (opts === undefined) return <Spinner />
  if (opts === null) return <p className="t-support">The door scanner needs the latest database update (migration 43).</p>
  if (!opts.role) return <p className="t-support">You are not on the door team for this event, or your access has expired. Ask the organiser.</p>
  const start = async () => {
    setBusy(true)
    try { onStart(await startScanSession(eventId, gate || null, session || null, deviceLabel())) } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }
  const needGate = opts.gates.length > 0
  return (
    <div className="card door-start">
      <h2 className="t-section">Start scanning</h2>
      <p className="t-meta">Role: <b>{opts.role === 'manager' ? 'Organiser (all gates)' : opts.role === 'supervisor' ? 'Supervisor' : 'Scanner'}</b>{opts.myGate ? ' · assigned to one gate' : ''}</p>
      {needGate && <Field id="door-gate" label="Your gate"><select id="door-gate" className="input" value={gate} disabled={!!opts.myGate} onChange={e => setGate(e.target.value)}>
        <option value="">Choose…</option>{opts.gates.map(g => <option key={g.id} value={g.id}>{g.name}{g.status === 'closed' ? ' (closed)' : ''}</option>)}</select></Field>}
      {opts.sessions.length > 0 && <Field id="door-session" label="Session" hint="Leave on automatic to check each ticket against the session open now."><select id="door-session" className="input" value={session} onChange={e => setSession(e.target.value)}>
        <option value="">Automatic</option>{opts.sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      <button className="btn primary" disabled={busy || (needGate && !gate)} onClick={() => void start()}><ScanLine size={18} aria-hidden /> Start scanner session</button>
    </div>
  )
}

function LiveDoor({ sess, onEnd }: { sess: ScanSession; onEnd: () => void }) {
  const [log, setLog] = useState<Entry[]>([])
  const [current, setCurrent] = useState<Entry | null>(null)
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<'entry' | 'exit'>('entry')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [torch, setTorch] = useState<boolean | null>(null)          // null: not supported by this camera
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [filter, setFilter] = useState<'all' | 'admit' | 'deny'>('all')
  const [camErr, setCamErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const track = useRef<MediaStreamTrack | null>(null)
  const busyRef = useRef(false)
  const lastRef = useRef<{ cred: string; at: number } | null>(null)
  const supervisor = sess.role === 'manager' || sess.role === 'supervisor'

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  const run = async (cred: string, requestId = newId(), m = mode) => {
    if (!cred || busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      const r = await scanTicket(sess.id, cred, requestId, m)
      const e: Entry = { id: requestId, at: Date.now(), cred, mode: m, r }
      setCurrent(e); setLog(l => [e, ...l.filter(x => x.id !== requestId)].slice(0, 200)); setCode('')
      setOnline(r.decision !== 'NOT_VERIFIED')
      const tone = DECISION_UI[r.decision].tone
      playSound(tone === 'admit' ? 'success' : 'unlike')
      if (navigator.vibrate) navigator.vibrate(tone === 'admit' ? 60 : tone === 'hold' ? [60, 60, 60] : [120, 80, 120])
    } finally { busyRef.current = false; setBusy(false) }
  }

  // Camera: rear camera, decode a few frames a second, ignore the same QR for 3 s (people hold the phone still).
  useEffect(() => {
    if (!scanning) return
    let stop = false, stream: MediaStream | null = null, timer = 0
    setCamErr('')
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        track.current = stream.getVideoTracks()[0] ?? null
        const caps = (track.current?.getCapabilities?.() ?? {}) as { torch?: boolean }
        setTorch(caps.torch ? false : null)
        if (video.current) { video.current.srcObject = stream; await video.current.play() }
        const { scan } = await createFrameScanner()
        const tick = async () => {
          if (stop || !video.current) return
          const found = await scan(video.current)
          const cred = found ? normaliseCredential(found) : ''
          const dup = lastRef.current && lastRef.current.cred === cred && Date.now() - lastRef.current.at < 3000
          if (cred && !dup) { lastRef.current = { cred, at: Date.now() }; await run(cred) }
          timer = window.setTimeout(tick, 200)
        }
        void tick()
      } catch (e) {
        const name = (e as { name?: string })?.name
        setCamErr(name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this site in your browser settings (tap the lock icon by the address), then try again.'
          : name === 'NotFoundError' ? 'No camera was found on this device. Type the code instead.'
          : name === 'NotReadableError' ? 'Another app is using the camera. Close it and try again.' : 'The camera could not start. Type the code instead.')
        setScanning(false)
      }
    })()
    return () => { stop = true; window.clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); track.current = null; setTorch(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning])

  const flip = async () => {
    if (!track.current || torch === null) return
    try { await track.current.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] }); setTorch(!torch) } catch { setTorch(null); toast('This camera has no flashlight control.') }
  }
  const override = async () => {
    const t = current?.r.decision === 'MANUAL_REVIEW' ? current.r.ticket : undefined
    if (!t) return
    const reason = prompt('Why are you admitting this ticket? (recorded with your name)')
    if (!reason || reason.trim().length < 5) { if (reason !== null) toast('Give a reason of at least a few words.'); return }
    try {
      const r = await overrideAdmission(sess.id, t.id, newId(), reason.trim())
      const e: Entry = { id: newId(), at: Date.now(), cred: t.ref, mode: 'entry', r }
      setCurrent(e); setLog(l => [e, ...l].slice(0, 200)); playSound(r.admit ? 'success' : 'unlike')
    } catch (err) { toast(errMsg(err)) }
  }
  const end = async () => { try { await endScanSession(sess.id) } catch { /* the session also ends when they start another */ } onEnd() }

  const shown = log.filter(e => filter === 'all' || (filter === 'admit' ? e.r.admit : !e.r.admit))
  const admitted = log.filter(e => e.r.decision === 'ACCEPTED' && !e.r.replay).length
  const ui = current ? DECISION_UI[current.r.decision] : null
  return (
    <div className="door">
      <div className="door-ctx card" role="status">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <p className="door-ev">{sess.event.title}</p>
            <p className="t-meta">{formatEventTime(sess.event.starts_at, sess.event.timezone)}{sess.event.venue ? ` · ${sess.event.venue}` : ''}</p>
            <p className="door-gate">{sess.gate ? sess.gate.name : 'All entrances'}{sess.session ? ` · ${sess.session.name}` : ''} · {sess.role === 'manager' ? 'Organiser' : sess.role === 'supervisor' ? 'Supervisor' : 'Scanner'}</p>
          </div>
          <span className={`door-net ${online ? 'on' : 'off'}`}>{online ? <Wifi size={16} aria-hidden /> : <WifiOff size={16} aria-hidden />} {online ? 'Online' : 'Offline'}</span>
        </div>
        {sess.event.status !== 'active' && <p className="error" style={{ marginTop: 6 }}>This event is {sess.event.status}. The server will refuse entry.</p>}
        {!online && <p className="door-offline">No connection: tickets cannot be verified, so nobody can be admitted from this phone until it reconnects. Scans are retried with the same ID, so nothing is counted twice.</p>}
      </div>

      <div className="door-mode" role="group" aria-label="Scan mode">
        <button className={`chip${mode === 'entry' ? ' on' : ''}`} aria-pressed={mode === 'entry'} onClick={() => setMode('entry')}>Entry</button>
        <button className={`chip${mode === 'exit' ? ' on' : ''}`} aria-pressed={mode === 'exit'} onClick={() => setMode('exit')}>Exit (re-entry tickets)</button>
        <span className="grow" />
        <span className="t-meta">{admitted} admitted this session</span>
      </div>

      {current && ui && (
        <div className={`door-result tone-${ui.tone}`} role="alert" aria-live="assertive">
          <div className="door-result-head">
            {ui.tone === 'admit' ? <CheckCircle2 size={44} aria-hidden /> : ui.tone === 'hold' ? <PauseCircle size={44} aria-hidden /> : <XCircle size={44} aria-hidden />}
            <div><p className="door-result-title">{current.mode === 'exit' && current.r.decision === 'EXITED' ? 'EXIT RECORDED' : ui.title}</p>
              <p className="door-result-sub">{ui.tone === 'admit' ? (current.r.decision === 'EXITED' ? 'Let them out' : 'Let them in') : ui.tone === 'hold' ? 'Do not admit yet' : 'Do not admit'}</p></div>
          </div>
          <ul className="door-result-lines">{decisionDetail(current.r, sess.event.timezone).map((l, i) => <li key={i}>{l}</li>)}</ul>
          {ui.hint && <p className="door-result-hint">{ui.hint}</p>}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {current.r.decision === 'NOT_VERIFIED' && <button className="btn" disabled={busy} onClick={() => void run(current.cred, current.id, current.mode)}>Retry this ticket</button>}
            {current.r.decision === 'MANUAL_REVIEW' && supervisor && current.r.ticket && <button className="btn" onClick={() => void override()}><CircleAlert size={16} aria-hidden /> Admit after checking (supervisor)</button>}
            <button className="btn ghost" onClick={() => setCurrent(null)}>Next ticket</button>
          </div>
        </div>
      )}

      <div className="door-cam">
        {scanning && <video ref={video} className="scan-video" playsInline muted aria-label="Camera preview for scanning tickets" />}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => setScanning(s => !s)}><ScanLine size={18} aria-hidden /> {scanning ? 'Stop camera' : 'Scan QR'}</button>
          {scanning && torch !== null && <button className="btn" aria-pressed={torch} onClick={() => void flip()}><Flashlight size={18} aria-hidden /> {torch ? 'Light off' : 'Light on'}</button>}
          {busy && <span className="t-meta">Checking…</span>}
        </div>
        {camErr && <p className="t-support" role="alert" style={{ marginTop: 8 }}>{camErr}</p>}
      </div>

      <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 8 }} onSubmit={e => { e.preventDefault(); void run(normaliseCredential(code)) }}>
        <div className="grow" style={{ minWidth: 200 }}><Field id="ds-code" label={supervisor ? 'Ticket code, or reference (VT-…) to look up' : 'Ticket code'} hint={supervisor ? 'A reference is a lookup, not proof: it always needs an ID check.' : undefined}>
          <input id="ds-code" className="input" value={code} autoCapitalize="characters" autoComplete="off" spellCheck={false} onChange={e => setCode(e.target.value)} placeholder={supervisor ? 'VT-ABCD-EFGH' : 'ABCDE FGHIJ KLMNO PQRST'} /></Field></div>
        <button className="btn" style={{ marginBottom: 16 }} disabled={busy || !code.trim()}>Check</button>
      </form>

      <section aria-labelledby="door-hist" style={{ marginTop: 12 }}>
        <div className="row between"><h3 id="door-hist" className="t-name">This session</h3>
          <div className="row" style={{ gap: 4 }} role="group" aria-label="Filter scans">{(['all', 'admit', 'deny'] as const).map(f =>
            <button key={f} className={`chip sm${filter === f ? ' on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'admit' ? 'Admitted' : 'Refused'}</button>)}</div></div>
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {shown.map(e => {
            const u = DECISION_UI[e.r.decision]
            return (
              <li key={e.id} className={`scan scan-${u.tone === 'admit' ? 'ok' : u.tone === 'hold' ? 'used' : 'invalid'}`}>
                <b>{u.title}{e.mode === 'exit' ? ' (exit)' : ''}</b>
                <span>{'ticket' in e.r && e.r.ticket ? `${e.r.ticket.ref} · ${e.r.ticket.type}` : `…${e.cred.slice(-5)}`}</span>
                <span className="t-meta">{new Date(e.at).toLocaleTimeString()}</span>
              </li>)
          })}
          {!shown.length && <li className="t-meta">No scans yet.</li>}
        </ul>
      </section>

      <button className="btn ghost" style={{ marginTop: 16 }} onClick={() => void end()}><LogOut size={16} aria-hidden /> End scanner session</button>
    </div>
  )
}
