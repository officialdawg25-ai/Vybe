import { describe, expect, it, beforeEach } from 'vitest'
import { doorCsvRows, isReferralCode, promoterUrl, referralFor, rememberReferral, salesCsvRows, type SalesRow } from '../../src/lib/reputation'
import { toCsv } from '../../src/lib/finance'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
})

describe('promoter attribution', () => {
  it('accepts only the server code shape', () => {
    expect(isReferralCode('AB12CD34')).toBe(true)
    for (const bad of ['ab12cd34', 'AB12CD3', 'AB12CD345', 'AB12-D34', '', null, undefined]) expect(isReferralCode(bad)).toBe(false)
  })
  it('remembers a code per event, upper-cased, and ignores junk', () => {
    rememberReferral('e1', 'ab12cd34'); rememberReferral('e2', "<script>")
    expect(referralFor('e1')).toBe('AB12CD34'); expect(referralFor('e2')).toBeNull()
    rememberReferral('e1', null); expect(referralFor('e1')).toBe('AB12CD34')            // a later visit without ?ref keeps the first
  })
  it('builds the share link', () => { expect(promoterUrl('e1', 'AB12CD34', 'https://vybe.example')).toBe('https://vybe.example/app/plans/e1?ref=AB12CD34') })
})

describe('exports', () => {
  const row: SalesRow = { order: 'abcd1234', created_at: '2026-10-01T10:00:00Z', paid_at: '2026-10-01T10:01:00Z', status: 'paid', provider: 'payfast', tickets: 2, ticket_subtotal_cents: 30001, buyer_fee_cents: 1800, commission_cents: 1500, organizer_net_cents: 28501, refunded_cents: 0, promoter_code: null }
  it('turns integer cents into exact rand strings', () => {
    const [head, r] = salesCsvRows([row])
    expect(head).toContain('Your net (ZAR)')
    expect(r).toEqual(['abcd1234', row.created_at, row.paid_at, 'paid', 'payfast', 2, '300.01', '18.00', '15.00', '285.01', '0.00', ''])
  })
  it('falls back to the subtotal as net for orders priced before fee policies', () => {
    expect(salesCsvRows([{ ...row, commission_cents: null, organizer_net_cents: null }])[1][9]).toBe('300.01')
  })
  it('neutralises spreadsheet formulas in names but leaves negative amounts alone', () => {
    const csv = toCsv([...doorCsvRows([{ holder: '=HYPERLINK("http://x","y")', ticket_type: '+GA', status: 'valid', checked_in_at: null }]), ['-12.50', -3]])
    expect(csv.split('\n')[1]).toBe(`"'=HYPERLINK(""http://x"",""y"")",'+GA,valid,`)
    expect(csv.split('\n')[2]).toBe('-12.50,-3')
  })
})
