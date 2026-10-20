import { describe, expect, it } from 'vitest'
import { md5 } from '../../worker/md5'
import { ozowCheckout, payfastCheckout, payfastSignature, pfEncode, rands, sha512Hex, toCents, verifyOzowHash, verifyPayfastSignature, type Env, type OrderRow } from '../../worker/payments'

describe('md5', () => {
  it('matches RFC 1321 test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0')
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a')
  })
  it('handles non-ASCII (UTF-8)', () => expect(md5('Ångström')).toMatch(/^[0-9a-f]{32}$/))
})

const env = { PAYFAST_MERCHANT_ID: '10000100', PAYFAST_MERCHANT_KEY: '46f0cd694581a', PAYFAST_PASSPHRASE: 'jt7NOE43FZPn', PAYFAST_SANDBOX: '1', OZOW_SITE_CODE: 'TSTSTE0001', OZOW_PRIVATE_KEY: '215114531AFF7134A94C88CEEA48E', OZOW_IS_TEST: '1', APP_ORIGIN: 'https://vybe.test', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', ASSETS: { fetch: async () => new Response() } } as Env
const order: OrderRow = { id: '3f2b8c1e-0a5d-4e6f-9b7a-1c2d3e4f5a6b', buyer: 'u', event_id: 'e', status: 'pending', provider: 'payfast', total_cents: 16050, expires_at: '2099-01-01' }

describe('PayFast', () => {
  it('encodes like PHP urlencode', () => { expect(pfEncode("a b&c!'()*~")).toBe('a+b%26c%21%27%28%29%2A%7E') })
  it('signs fields in posted order, skipping empties, with the passphrase last', () => {
    const f: [string, string][] = [['merchant_id', '10000100'], ['name_first', ''], ['amount', '100.00'], ['item_name', 'Cheese Burger']]
    expect(payfastSignature(f, 'pass')).toBe(md5('merchant_id=10000100&amount=100.00&item_name=Cheese+Burger&passphrase=pass'))
  })
  it('builds a sandbox checkout whose signature the ITN verifier accepts as-is', () => {
    const c = payfastCheckout(env, order, { email: 'a@b.co', name: 'Ann Lee' }, 'Tickets: Rooftop')
    expect(c.action).toBe('https://sandbox.payfast.co.za/eng/process')
    expect(c.fields.amount).toBe('160.50'); expect(c.fields.m_payment_id).toBe(order.id)
    expect(verifyPayfastSignature(Object.entries(c.fields), env.PAYFAST_PASSPHRASE)).toBe(true)
  })
  it('rejects tampering: changed amount, missing or wrong signature, wrong passphrase', () => {
    const c = payfastCheckout(env, order, { email: 'a@b.co', name: 'Ann' }, 'T')
    expect(verifyPayfastSignature(Object.entries({ ...c.fields, amount: '1.00' }), env.PAYFAST_PASSPHRASE)).toBe(false)
    expect(verifyPayfastSignature(Object.entries({ ...c.fields, signature: '0'.repeat(32) }), env.PAYFAST_PASSPHRASE)).toBe(false)
    const { signature: _s, ...unsigned } = c.fields
    expect(verifyPayfastSignature(Object.entries(unsigned), env.PAYFAST_PASSPHRASE)).toBe(false)
    expect(verifyPayfastSignature(Object.entries(c.fields), 'other')).toBe(false)
  })
})

describe('Ozow', () => {
  it('hashes lower-cased concatenation with the private key (SHA-512) and posts to pay.ozow.com', async () => {
    const c = await ozowCheckout(env, { ...order, provider: 'ozow' }, { email: 'a@b.co' })
    expect(c.action).toBe('https://pay.ozow.com')
    expect(c.fields.Amount).toBe('160.50'); expect(c.fields.IsTest).toBe('true'); expect(c.fields.HashCheck).toMatch(/^[0-9a-f]{128}$/)
    const f = c.fields
    const raw = [f.SiteCode, f.CountryCode, f.CurrencyCode, f.Amount, f.TransactionReference, f.BankReference, '', '', '', '', '', f.Customer, f.CancelUrl, f.ErrorUrl, f.SuccessUrl, f.NotifyUrl, f.IsTest, env.OZOW_PRIVATE_KEY].join('').toLowerCase()
    expect(f.HashCheck).toBe(await sha512Hex(raw))
  })
  it('verifies notifications and rejects altered ones', async () => {
    const base: Record<string, string> = { SiteCode: 'TSTSTE0001', TransactionId: 't-1', TransactionReference: order.id, Amount: '160.50', Status: 'Complete', Optional1: '', Optional2: '', Optional3: '', Optional4: '', Optional5: '', CurrencyCode: 'ZAR', IsTest: 'true', StatusMessage: 'ok' }
    const order_ = ['SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status', 'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'CurrencyCode', 'IsTest', 'StatusMessage']
    const hash = await sha512Hex((order_.map(k => base[k]).join('') + env.OZOW_PRIVATE_KEY).toLowerCase())
    expect(await verifyOzowHash(new URLSearchParams({ ...base, Hash: hash }), env.OZOW_PRIVATE_KEY!)).toBe(true)
    expect(await verifyOzowHash(new URLSearchParams({ ...base, Amount: '1.00', Hash: hash }), env.OZOW_PRIVATE_KEY!)).toBe(false)
    expect(await verifyOzowHash(new URLSearchParams(base), env.OZOW_PRIVATE_KEY!)).toBe(false)
  })
})

describe('money helpers', () => {
  it('formats and parses cents without float drift', () => {
    expect(rands(16050)).toBe('160.50'); expect(rands(5)).toBe('0.05'); expect(toCents('160.50')).toBe(16050); expect(toCents('0.07')).toBe(7); expect(toCents('19.99')).toBe(1999)
    expect(Number.isNaN(toCents('abc'))).toBe(true)
  })
})
