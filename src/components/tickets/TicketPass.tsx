import { useEffect, useState } from 'react'
import { VMark } from '../../brand/Logo'
import { QrCode } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { myTicketCode, myTicketQr } from '../../lib/trust'
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
export function useRotatingQr(ticketId: string, active: boolean) {
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
  }, [ticketId, active])
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
  const valid = t.status === 'valid'
  const code = useRotatingQr(t.id, open && valid)
  const tt = t.ticket_types
  return (
    <div className={`pass${open && valid ? ' open' : ''}${valid ? '' : ' spent'}`}>
      <TicketStub spent={!valid} tier={tt?.tier ?? guessTier(tt?.name ?? '', tt?.kind)} accent={tt?.accent} design={tt?.design} name={tt?.name ?? 'Ticket'} eventTitle={eventTitle}
        meta={<>{when && <span>{when}</span>}{where && <span>{where}</span>}</>} perks={tt?.perks}
        stub={<span className={`pass-status s-${t.status}`}>{STATUS[t.status] ?? t.status}</span>} />
      {t.status === 'used' && <div className="pass-qr pass-done"><VMark size={44} tone="dark" /><p className="t-meta">Used — this ticket has been scanned in.</p></div>}
      {valid && (
        <div className="pass-qr">
          {!open ? <button className="btn pass-show" onClick={() => setOpen(true)}><QrCode size={18} aria-hidden /> Show entry QR</button> : (
            code === null ? <p className="t-support">This ticket can’t be shown right now. Refresh, or contact support if it persists.</p> : (
              <>
                <div className="pass-qr-frame">{code ? <BrandedQr value={code} size={232} /> : <div className="skeleton" style={{ width: 232, height: 232 }} />}</div>
                {code && <p className="pass-live" aria-live="off"><span className="pass-pulse" aria-hidden /> Live code · refreshes every 30 seconds</p>}
                <p className="t-meta pass-hint">Show this at the door. The code changes every 30 seconds and works once, for this event only, so a screenshot won’t get in.</p>
                <button className="btn ghost sm" onClick={() => setOpen(false)}>Hide QR</button>
              </>))}
          {actions}
        </div>
      )}
    </div>
  )
}
