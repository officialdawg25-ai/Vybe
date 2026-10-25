import { describe, expect, it } from 'vitest'
import { bpsOf, modelScenario, priceOrder, vatIn, type FeeTerms } from '../../src/lib/pricing'

const T = (o: Partial<FeeTerms> = {}): FeeTerms => ({ commission_bps: 0, commission_fixed_cents: 0, commission_per_ticket_cents: 0, buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0, ...o })

describe('pricing (mirrors public.price_order)', () => {
  it('rounds half up, in exact integers', () => {
    expect(bpsOf(10, 500)).toBe(1)            // 0.5 → 1
    expect(bpsOf(9, 500)).toBe(0)             // 0.45 → 0
    expect(bpsOf(33333, 500)).toBe(1667)      // 1666.65 → 1667
    expect(bpsOf(4_999_999_999, 3000)).toBe(1_500_000_000)   // big amounts stay exact (no float drift)
    expect(vatIn(11500, 1500)).toBe(1500); expect(vatIn(1, 1500)).toBe(0); expect(vatIn(4, 1500)).toBe(1)
  })
  it('organiser commission: net + commission always equals the ticket subtotal; buyer pays the face value', () => {
    for (const sub of [0, 1, 99, 15000, 33333, 4_999_999]) {
      const p = priceOrder(T({ commission_bps: 500 }), sub, 1)
      expect(p.organizer_net_cents + p.commission_cents).toBe(sub)
      expect(p.total_cents).toBe(sub); expect(p.buyer_fee_cents).toBe(0)
    }
  })
  it('the launch terms (buyer fee 5 % + R3) price a R150 ticket at R160.50', () => {
    const p = priceOrder(T({ buyer_fee_enabled: true, buyer_fee_bps: 500, buyer_fee_fixed_cents: 300 }), 15000, 1)
    expect(p).toMatchObject({ buyer_fee_cents: 1050, total_cents: 16050, commission_cents: 0, organizer_net_cents: 15000 })
  })
  it('commission never exceeds the ticket subtotal; free orders are free', () => {
    expect(priceOrder(T({ commission_bps: 3000, commission_fixed_cents: 100000 }), 5000, 1).commission_cents).toBe(5000)
    expect(priceOrder(T({ commission_bps: 500, buyer_fee_enabled: true, buyer_fee_fixed_cents: 300 }), 0, 2)).toMatchObject({ total_cents: 0, commission_cents: 0, buyer_fee_cents: 0 })
  })
  it('per-ticket amounts scale with tickets, not orders', () => {
    expect(priceOrder(T({ commission_per_ticket_cents: 50 }), 30000, 3).commission_cents).toBe(150)
  })
  it('VAT is carved out of VYBE’s own charges only', () => {
    const p = priceOrder(T({ commission_bps: 500, buyer_fee_enabled: true, buyer_fee_bps: 500 }), 23000, 1, { registered: true, rate_bps: 1500 })
    expect(p.commission_vat_cents).toBe(vatIn(1150, 1500)); expect(p.buyer_fee_vat_cents).toBe(vatIn(1150, 1500))
    expect(p.organizer_net_cents).toBe(23000 - 1150)
  })
  it('rejects nonsense input', () => {
    expect(() => priceOrder(T(), -1, 1)).toThrow(); expect(() => priceOrder(T(), 1.5, 1)).toThrow()
  })
  it('the scenario calculator is labelled an estimate and keeps its sums consistent', () => {
    const m = modelScenario({ terms: T({ commission_bps: 500 }), price_cents: 25000, tickets: 400, orders: 200, refund_rate_bps: 0, processing_bps: 350, processing_fixed_cents: 200 })
    expect(m.estimate).toBe(true)
    expect(m.gross_ticket_sales_cents).toBe(25000 * 400)
    expect(m.organiser_payable_cents + priceOrder(T({ commission_bps: 500 }), 50000, 2).commission_cents * 200).toBe(m.gross_ticket_sales_cents)
    expect(m.net_platform_contribution_cents).toBe(m.platform_revenue_ex_vat_cents - m.assumed_processing_cost_cents)
  })
})
