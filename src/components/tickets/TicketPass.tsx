import { useEffect, useState } from 'react'
import { QrCode } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { myTicketCode } from '../../lib/trust'
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

const STATUS: Record<string, string> = { valid: 'Valid', used: 'Used', void: 'Void', refunded: 'Refunded' }

/** A branded ticket with its QR on the stub side. The QR is a normal QR code with a standalone V (see lib/brandQr). */
export function TicketPass({ t, eventTitle, when, where, startOpen = false, actions }: { t: PassTicket; eventTitle?: string; when?: string; where?: string; startOpen?: boolean; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(startOpen)
  const valid = t.status === 'valid'
  const code = useTicketCode(t.id, open && valid)
  const tt = t.ticket_types
  return (
    <div className={`pass${open && valid ? ' open' : ''}${valid ? '' : ' spent'}`}>
      <TicketStub tier={tt?.tier ?? guessTier(tt?.name ?? '', tt?.kind)} accent={tt?.accent} design={tt?.design} name={tt?.name ?? 'Ticket'} eventTitle={eventTitle}
        meta={<>{when && <span>{when}</span>}{where && <span>{where}</span>}</>} perks={tt?.perks}
        stub={<span className={`pass-status s-${t.status}`}>{STATUS[t.status] ?? t.status}</span>} />
      {valid && (
        <div className="pass-qr">
          {!open ? <button className="btn pass-show" onClick={() => setOpen(true)}><QrCode size={18} aria-hidden /> Show entry QR</button> : (
            code === null ? <p className="t-support">This ticket can’t be shown right now. Refresh, or contact support if it persists.</p> : (
              <>
                <div className="pass-qr-frame">{code ? <BrandedQr value={code} size={232} /> : <div className="skeleton" style={{ width: 232, height: 232 }} />}</div>
                {code && <p className="pass-code">{code.match(/.{1,5}/g)?.join(' ')}</p>}
                <p className="t-meta pass-hint">Show this at the door. It’s checked live, so a screenshot of a used, refunded or transferred ticket won’t get in. Don’t post it publicly.</p>
                <button className="btn ghost sm" onClick={() => setOpen(false)}>Hide QR</button>
              </>))}
          {actions}
        </div>
      )}
    </div>
  )
}
