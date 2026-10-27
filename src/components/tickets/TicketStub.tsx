import type { CSSProperties, ReactNode } from 'react'
import { Crown, Gem, Sparkles, Star, Ticket, Users } from 'lucide-react'
import { VMark } from '../../brand/Logo'
import { tierStyle, TIERS } from '../../lib/ticketTiers'
import type { TicketDesign, TierKey } from '../../lib/tickets'

const ICON: Record<TierKey, typeof Ticket> = { general: Ticket, early_bird: Sparkles, vip: Crown, vvip: Gem, backstage: Star, student: Ticket, table: Users, group: Users }

/**
 * A branded ticket: the tier's colours (or the organiser's accent), its design, perks, and a perforated stub on the right
 * for whatever the screen needs there (quantity, a QR code, a status). Purely visual; prices and rules live on the server.
 */
export function TicketStub({ tier, accent, design = 'aurora', name, eventTitle, price, meta, perks, stub, children, compact, spent, className = '' }: {
  tier?: TierKey; accent?: string | null; design?: TicketDesign; name: string; eventTitle?: string; price?: string; meta?: ReactNode
  perks?: string[]; stub?: ReactNode; children?: ReactNode; compact?: boolean; spent?: boolean; className?: string
}) {
  const t = tierStyle(tier, accent)
  const Icon = ICON[tier ?? 'general'] ?? Ticket
  const style = { '--tk-from': t.from, '--tk-to': t.to, '--tk-ink': t.ink, '--tk-glow': t.glow } as CSSProperties
  return (
    <div className={`tk tk-${design}${compact ? ' tk-compact' : ''} ${className}`} style={style} data-tier={tier ?? 'general'}>
      <span className="tk-vmark" aria-hidden><VMark size={compact ? 54 : 86} tone={spent ? 'dark' : 'light'} /></span>
      <div className="tk-main">
        <div className="tk-top">
          <span className="tk-chip"><Icon size={13} aria-hidden /> {TIERS[tier ?? 'general']?.label ?? 'General'}</span>
          {price && <span className="tk-price">{price}</span>}
        </div>
        <div className="tk-name">{name}</div>
        {eventTitle && <div className="tk-event">{eventTitle}</div>}
        {meta && <div className="tk-meta">{meta}</div>}
        {!!perks?.length && <ul className="tk-perks">{perks.map(p => <li key={p}>{p}</li>)}</ul>}
        {children}
      </div>
      {stub !== undefined && <div className="tk-stub">{stub}</div>}
    </div>
  )
}
