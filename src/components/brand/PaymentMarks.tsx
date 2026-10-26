import { useState } from 'react'
import { MARKS } from '../../lib/paymentMarks'

/**
 * Payment brand marks for checkout. PayFast's logo is the official file published in WooCommerce's PayFast gateway
 * (public/brands/payfast.png). Ozow's official logo can be dropped in as public/brands/ozow.svg; until then its name is
 * set in type. Card and wallet marks come from simple-icons. All are shown only to identify how the buyer can pay.
 */
export function ProviderLogo({ provider, height = 20 }: { provider: 'payfast' | 'ozow'; height?: number }) {
  const [failed, setFailed] = useState(false)
  if (provider === 'payfast') return <span className="pm-logo"><img src="/brands/payfast.png" alt="PayFast" height={height} style={{ height, width: 'auto' }} /></span>
  if (failed) return <span className="pm-logo pm-word" aria-label="Ozow">ozow</span>
  return <span className="pm-logo"><img src="/brands/ozow.svg" alt="Ozow" height={height} style={{ height, width: 'auto' }} onError={() => setFailed(true)} /></span>
}

export function Mark({ id, size = 22 }: { id: keyof typeof MARKS; size?: number }) {
  const m = MARKS[id]
  return (
    <span className="pm-mark" title={m.title}>
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={m.title}><path d={m.path} fill={m.hex} /></svg>
    </span>
  )
}

/** What each provider lets buyers use (as configured on VYBE's merchant accounts). */
export function ProviderMethods({ provider }: { provider: 'payfast' | 'ozow' }) {
  return provider === 'payfast'
    ? <span className="pm-methods"><Mark id="visa" /><Mark id="mastercard" /><span className="pm-text">Cards, Instant EFT &amp; more</span></span>
    : <span className="pm-methods"><span className="pm-text">Pay from your bank app · no card needed</span></span>
}
