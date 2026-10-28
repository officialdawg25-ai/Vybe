import { useEffect, useState } from 'react'
import { VMark } from '../../brand/Logo'
import { QrCode } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { myTicketCode, myTicketQr } from '../../lib/trust'
import { myTicketDetails, reissueTicket, stillAdmits, type TicketDetails } from '../../lib/admission'
import { errMsg, toast } from '../../ui'
import { guessTier } from '../../lib/ticketTiers'
import type { TicketDesign, TierKey } from '../../lib/tickets'
import { BrandedQr } from './BrandedQr'
import { TicketStub } from './TicketStub'

export interface PassTicket {
  id: string; status: string
  ticket_types: { name: string; kind?: string; tier?: TierKey; accent?: string | null; design?: TicketDesign; perks?: string[] } | null
}

/** The holder's code, fetched only when they open it (organisers and door staff never read codes). */
export function useTicketCode(ticketId: string, open: boolean) {
  const [code, setCode] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!open || code !== undefined) return
    let live = true
    void (async () => {
      let c = await myTicketCode(ticketId)
      if (c == null) {                                         // a server before migration 28 still lets the holder read it directly
        const { data } = await supabase.from('tickets').select('code').eq('id', ticketId).maybeSingle()
        c = (data as { code?: string } | null)?.code ?? null
      }
      if (live) setCode(c)
    })()
    return () => { live = false }
  }, [ticketId, open, code])
  return code
}

/**
 * What the QR shows right now: a signed token that changes every 30 seconds. The app fetches the next few minutes of tokens
 * while it is online and steps through them by the server's clock, so the QR keeps changing even when the venue signal drops.
 * Falls back to the plain code only while the server still allows it (before rotation is required, or before migration 37).
 */
export function useRotatingQr(ticketId: string, active: boolean, version = 0) {
  const plain = useTicketCode(ticketId, active)
  const [pack, setPack] = useState<{ tokens: { w: number; token: string }[]; step: number; offset: number } | null | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    let live = true
    const load = async () => {
      const r = await myTicketQr(ticketId, 12).catch(() => null)
      if (!live) return
      setPack(r ? { tokens: r.tokens, step: r.step_seconds * 1000, offset: r.server_epoch * 1000 - Date.now() } : null)
    }
    void load()
    const t = window.setInterval(() => { setNow(Date.now()); }, 1000)
    const refresh = window.setInterval(load, 4 * 60_000)
    const vis = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', vis)
    return () => { live = false; window.clearInterval(t); window.clearInterval(refresh); document.removeEventListener('visibilitychange', vis) }
  }, [ticketId, active, version])
  if (!active) return undefined
  if (pack === undefined) return undefined
  if (pack === null) return plain                                  // an older server: the plain code, if it will still be accepted
  const w = Math.floor((now + pack.offset) / pack.step)
  const hit = pack.tokens.find(x => x.w === w) ?? pack.tokens[pack.tokens.length - 1]
  return hit?.token.toUpperCase() ?? null            // upper case lets the QR use its compact alphanumeric mode (the door accepts any case)
}

const STATUS: Record<string, string> = { valid: 'Valid', used: 'Used', void: 'Void', refunded: 'Refunded' }

/** A branded ticket with its QR on the stub side. The QR is a normal QR code with a standalone V (see lib/brandQr). */
export function TicketPass({ t, eventTitle, when, where, startOpen = false, actions }: { t: PassTicket; eventTitle?: string; when?: string; where?: string; startOpen?: boolean; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(startOpen)
  const [details, setDetails] = useState<TicketDetails | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (t.status !== 'valid' && t.status !== 'used') return
    let live = true
    void myTicketDetails(t.id).then(d => { if (live) setDetails(d) })
    return () => { live = false }
  }, [t.id, t.status, version])
  // A used ticket still shows its QR when it allows re-entry or has sessions left (the server decides at the door).
  const valid = stillAdmits(t.status, details)
  const code = useRotatingQr(t.id, open && valid, version)
  const reissue = async () => {
    if (!confirm('Get a new QR for this ticket? Every earlier QR, screenshot and code for it stops working at once.')) return
    try { await reissueTicket(t.id, 'holder asked for a new QR'); setVersion(v => v + 1); toast('New QR ready. Old copies no longer work.') } catch (e) { toast(errMsg(e)) }
  }
  const tt = t.ticket_types
  return (
    <div className={`pass${open && valid ? ' open' : ''}${valid ? '' : ' spent'}`}>
      <TicketStub spent={!valid} tier={tt?.tier ?? guessTier(tt?.name ?? '', tt?.kind)} accent={tt?.accent} design={tt?.design} name={tt?.name ?? 'Ticket'} eventTitle={eventTitle}
        meta={<>{when && <span>{when}</span>}{where && <span>{where}</span>}</>} perks={tt?.perks}
        stub={<span className={`pass-status s-${t.status}`}>{STATUS[t.status] ?? t.status}</span>} />
      {details && <TicketFacts d={details} />}
      {t.status === 'used' && !valid && <div className="pass-qr pass-done"><VMark size={44} tone="dark" /><p className="t-meta">Used — this ticket has been scanned in.</p></div>}
      {valid && (
        <div className="pass-qr">
          {!open ? <button className="btn pass-show" onClick={() => setOpen(true)}><QrCode size={18} aria-hidden /> Show entry QR</button> : (
            code === null ? <p className="t-support">This ticket can’t be shown right now. Refresh, or contact support if it persists.</p> : (
              <>
                <div className="pass-qr-frame">{code ? <BrandedQr value={code} size={232} /> : <div className="skeleton" style={{ width: 232, height: 232 }} />}</div>
                {code && <p className="pass-live" aria-live="off"><span className="pass-pulse" aria-hidden /> Live code · refreshes every 30 seconds</p>}
                <p className="t-meta pass-hint">Show this at the door. The code changes every 30 seconds and only works for this event, so a screenshot won’t get in.</p>
                <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button className="btn ghost sm" onClick={() => setOpen(false)}>Hide QR</button>
                  {details && <button className="btn ghost sm" onClick={() => void reissue()}>Lost phone or shared a screenshot? Get a new QR</button>}
                </div>
              </>))}
          {actions}
        </div>
      )}
    </div>
  )
}

/** What this ticket grants and where to go: from the server, never inferred from the ticket's colour or name. */
function TicketFacts({ d }: { d: TicketDetails }) {
  const at = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: d.timezone || undefined })
  return (
    <dl className="pass-facts">
      <div><dt>Ticket</dt><dd>{d.ref}</dd></div>
      <div><dt>Seat</dt><dd>{d.seat}</dd></div>
      {d.zones.length > 0 && <div><dt>Access</dt><dd>{d.zones.join(', ')}</dd></div>}
      {d.gates.length > 0 && <div><dt>Entrance</dt><dd>{d.gates.join(', ')}</dd></div>}
      {d.sessions.length > 0 ? <div><dt>Sessions</dt><dd>{d.sessions.map(s => `${s.name}${s.used ? ' (used)' : ''}`).join(' · ')}</dd></div>
        : <div><dt>Entry</dt><dd>{at(d.entry_opens_at)} – {at(d.entry_closes_at)}</dd></div>}
      <div><dt>Entries</dt><dd>{d.entry_policy === 'reentry' ? `Re-entry allowed${d.max_entries ? ` (up to ${d.max_entries})` : ''} — scan out when you leave` : 'One entry'}</dd></div>
      {d.event_status === 'postponed' && <div><dt>Status</dt><dd>Event postponed — this ticket stays valid for the new date</dd></div>}
    </dl>
  )
}
