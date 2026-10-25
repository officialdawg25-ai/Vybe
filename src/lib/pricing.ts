/**
 * Ticket pricing under a fee policy, in integer cents. This mirrors public.price_order in migration 27 exactly (the database
 * is the authority that prices real orders; this copy powers previews and the admin commercial calculator, and a test checks
 * both agree). No floating point touches money: percentages are basis points and every division is integer, half-up.
 */
export interface FeeTerms {
  commission_bps: number; commission_fixed_cents: number; commission_per_ticket_cents: number
  buyer_fee_enabled: boolean; buyer_fee_bps: number; buyer_fee_fixed_cents: number; buyer_fee_per_ticket_cents: number
}
export interface Priced {
  subtotal_cents: number; buyer_fee_cents: number; buyer_fee_vat_cents: number; commission_cents: number; commission_vat_cents: number
  organizer_net_cents: number; total_cents: number
}

const big = (n: number) => BigInt(Math.trunc(n))
/** Half-up share of a non-negative amount in basis points: floor((amount × bps + 5000) / 10000). */
export const bpsOf = (amount: number, bps: number) => Number((big(amount) * big(bps) + 5000n) / 10000n)
/** VAT contained in a VAT-inclusive amount, half-up: floor((amount × rate + (10000 + rate) / 2) / (10000 + rate)). */
export const vatIn = (amount: number, rateBps: number) => Number((big(amount) * big(rateBps) + big(Math.floor((10000 + rateBps) / 2))) / big(10000 + rateBps))

export function priceOrder(t: FeeTerms, subtotal: number, units: number, vat: { registered: boolean; rate_bps: number } = { registered: false, rate_bps: 0 }): Priced {
  if (!Number.isInteger(subtotal) || !Number.isInteger(units) || subtotal < 0 || units < 0) throw new Error('invalid pricing input')
  let fee = 0, commission = 0, feeVat = 0, commissionVat = 0
  if (subtotal > 0) {
    if (t.buyer_fee_enabled) fee = bpsOf(subtotal, t.buyer_fee_bps) + t.buyer_fee_fixed_cents + t.buyer_fee_per_ticket_cents * units
    commission = Math.min(subtotal, bpsOf(subtotal, t.commission_bps) + t.commission_fixed_cents + t.commission_per_ticket_cents * units)
    if (vat.registered) { feeVat = vatIn(fee, vat.rate_bps); commissionVat = vatIn(commission, vat.rate_bps) }
  }
  return { subtotal_cents: subtotal, buyer_fee_cents: fee, buyer_fee_vat_cents: feeVat, commission_cents: commission, commission_vat_cents: commissionVat,
    organizer_net_cents: subtotal - commission, total_cents: subtotal + fee }
}

export interface Scenario {
  terms: FeeTerms; price_cents: number; tickets: number; refund_rate_bps: number
  /** An ASSUMED processing cost for modelling only (basis points + fixed per order) — not a provider quote. */
  processing_bps: number; processing_fixed_cents: number; orders: number
  vat?: { registered: boolean; rate_bps: number }
}
/**
 * The commercial calculator: what a sales scenario would mean for buyers, the organiser and VYBE. Clearly an estimate:
 * every order is assumed to be the same size, refunds return the ticket price and its commission (not the buyer fee), and
 * processing costs are whatever the caller assumes.
 */
export function modelScenario(s: Scenario) {
  const perOrderTickets = Math.max(1, Math.round(s.tickets / Math.max(1, s.orders)))
  const one = priceOrder(s.terms, s.price_cents * perOrderTickets, perOrderTickets, s.vat)
  const n = s.orders
  const gross = one.subtotal_cents * n, collected = one.total_cents * n
  const refunded = bpsOf(gross, s.refund_rate_bps)
  const commission = one.commission_cents * n, commissionVat = one.commission_vat_cents * n
  const commissionReturned = gross > 0 ? Number((big(refunded) * big(commission) + big(Math.floor(gross / 2))) / big(gross)) : 0
  const fees = one.buyer_fee_cents * n, feeVat = one.buyer_fee_vat_cents * n
  const processing = bpsOf(collected, s.processing_bps) + s.processing_fixed_cents * n
  const platformRevenueExVat = (commission - commissionVat) + (fees - feeVat) - (commissionReturned - vatIn(commissionReturned, s.vat?.registered ? s.vat.rate_bps : 0))
  return {
    estimate: true as const,
    per_order: one,
    gross_ticket_sales_cents: gross,
    collected_from_buyers_cents: collected,
    refunds_cents: refunded,
    organiser_payable_cents: one.organizer_net_cents * n - (refunded - commissionReturned),
    platform_revenue_ex_vat_cents: platformRevenueExVat,
    assumed_processing_cost_cents: processing,
    net_platform_contribution_cents: platformRevenueExVat - processing,
  }
}
