import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { createFrameScanner } from '../../lib/qr'
import { playSound } from '../../lib/sounds'
import { ADMIT_TEXT, admitTicket, type AdmitResult } from '../../lib/trust'
import { Field, errMsg, toast } from '../../ui'

type Scan = { result: AdmitResult; ticket_type?: string; holder?: string; used_at?: string; code: string; at: number }

/**
 * Door check-in for one event: type or scan a ticket. The server decides (ticket, event, payment and refund state, door
 * team membership) and redeems atomically, so two phones scanning the same ticket can never both let it in. Every
 * attempt is logged on the server; this screen only shows the answer.
 */
export function DoorScanner({ eventId }: { eventId: string }) {
  const [code, setCode] = useState('')
  const [log, setLog] = useState<Scan[]>([])
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [counts, setCounts] = useState<{ total: number; used: number } | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const busyRef = useRef(false)

  // Checked-in count (managers can read ticket statuses; door staff without that access simply see no count).
  useEffect(() => {
    let live = true
    void supabase.from('tickets').select('status').eq('event_id', eventId).limit(5000).then(({ data, error }) => {
      if (!live) return
      if (error || !data) { setCounts(null); return }
      setCounts({ total: data.filter(r => r.status === 'valid' || r.status === 'used').length, used: data.filter(r => r.status === 'used').length })
    })
    return () => { live = false }
  }, [eventId, log.length])

  const submit = async (raw: string) => {
    const c = raw.trim().replace(/\s+/g, '').toUpperCase()
    if (!c || busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      const r = await admitTicket(eventId, c)
      setLog(l => [{ ...r, code: c.replace(/^VYBE1:?/, '').slice(-5), at: Date.now() }, ...l].slice(0, 25)); setCode('')
      playSound(r.result === 'ok' ? 'success' : 'unlike')
      if (navigator.vibrate) navigator.vibrate(r.result === 'ok' ? 60 : [80, 60, 80])
    } catch (e) { toast(errMsg(e)) } finally { busyRef.current = false; setBusy(false) }
  }

  const canScan = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  useEffect(() => {
    if (!scanning) return
    let stop = false, stream: MediaStream | null = null, timer = 0
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (video.current) { video.current.srcObject = stream; await video.current.play() }
        const { scan } = await createFrameScanner()
        const tick = async () => {
          if (stop || !video.current) return
          const found = await scan(video.current)
          if (found) { await submit(found); await new Promise(r => setTimeout(r, 1500)) }
          timer = window.setTimeout(tick, 250)
        }
        tick()
      } catch { toast('Camera not available. Type the code instead.'); setScanning(false) }
    })()
    return () => { stop = true; window.clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning])

  return (
    <>
      {counts && <p className="t-name" style={{ marginBottom: 12 }}>{counts.used} of {counts.total} checked in</p>}
      <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); void submit(code) }}>
        <div className="grow" style={{ minWidth: 200 }}><Field id="ds-code" label="Ticket code"><input id="ds-code" className="input" value={code} autoCapitalize="characters" autoComplete="off" spellCheck={false} onChange={e => setCode(e.target.value)} placeholder="ABCDE FGHIJ KLMNO PQRST" /></Field></div>
        <button className="btn primary" style={{ marginBottom: 16 }} disabled={busy || !code.trim()}>Check in</button>
        {canScan && <button type="button" className="btn" style={{ marginBottom: 16 }} onClick={() => setScanning(s => !s)}>{scanning ? 'Stop camera' : 'Scan QR'}</button>}
      </form>
      {scanning && <video ref={video} className="scan-video" playsInline muted aria-label="Camera preview for scanning tickets" />}
      <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-live="polite">
        {log.map(s => (
          <li key={s.at} className={`scan scan-${s.result === 'ok' ? 'ok' : s.result === 'already_used' ? 'used' : 'invalid'}`}>
            <b>{ADMIT_TEXT[s.result] ?? s.result}</b>
            <span>{s.holder ? `${s.holder} · ` : ''}{s.ticket_type ?? ''}{s.used_at ? ` · used ${new Date(s.used_at).toLocaleTimeString()}` : ''}</span>
            <span className="t-meta">…{s.code}</span>
          </li>))}
      </ul>
    </>
  )
}
