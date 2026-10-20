import { md5 } from './md5'

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> }
  APP_ORIGIN: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  PAYFAST_MERCHANT_ID?: string
  PAYFAST_MERCHANT_KEY?: string
  PAYFAST_PASSPHRASE?: string
  PAYFAST_SANDBOX?: string        // "1" → sandbox.payfast.co.za
  OZOW_SITE_CODE?: string
  OZOW_PRIVATE_KEY?: string
  OZOW_API_KEY?: string           // optional: lets us double-check "Complete" with Ozow directly
  OZOW_IS_TEST?: string           // "1" → test mode
}

export interface OrderRow { id: string; buyer: string; event_id: string; status: string; provider: string | null; total_cents: number; expires_at: string }

export const rands = (cents: number) => (cents / 100).toFixed(2)
export const toCents = (amount: string) => { const n = Math.round(parseFloat(amount) * 100); return Number.isFinite(n) ? n : NaN }

/** PHP-style urlencode: uppercase hex, spaces as "+" (what PayFast signs against). */
export const pfEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** PayFast signature over fields in the exact order they are posted; empty values are skipped. */
export function payfastSignature(fields: [string, string][], passphrase?: string): string {
  const parts = fields.filter(([, v]) => v !== '').map(([k, v]) => `${k}=${pfEncode(v.trim())}`)
  if (passphrase) parts.push(`passphrase=${pfEncode(passphrase.trim())}`)
  return md5(parts.join('&'))
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export async function sha512Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface Checkout { action: string; method: 'POST'; fields: Record<string, string> }

export function payfastCheckout(env: Env, o: OrderRow, buyer: { email: string; name: string }, itemName: string): Checkout {
  const sandbox = env.PAYFAST_SANDBOX === '1'
  const fields: [string, string][] = [
    ['merchant_id', env.PAYFAST_MERCHANT_ID ?? ''], ['merchant_key', env.PAYFAST_MERCHANT_KEY ?? ''],
    ['return_url', `${env.APP_ORIGIN}/app/orders/${o.id}`], ['cancel_url', `${env.APP_ORIGIN}/app/orders/${o.id}?cancelled=1`],
    ['notify_url', `${env.APP_ORIGIN}/api/pay/payfast/itn`],
    ['name_first', buyer.name.slice(0, 100)], ['email_address', buyer.email],
    ['m_payment_id', o.id], ['amount', rands(o.total_cents)], ['item_name', itemName.slice(0, 100)],
  ]
  fields.push(['signature', payfastSignature(fields, env.PAYFAST_PASSPHRASE)])
  return { action: `https://${sandbox ? 'sandbox' : 'www'}.payfast.co.za/eng/process`, method: 'POST', fields: Object.fromEntries(fields) }
}

export async function ozowCheckout(env: Env, o: OrderRow, buyer: { email: string }): Promise<Checkout> {
  const f = {
    SiteCode: env.OZOW_SITE_CODE ?? '', CountryCode: 'ZA', CurrencyCode: 'ZAR', Amount: rands(o.total_cents),
    TransactionReference: o.id, BankReference: `VYBE-${o.id.slice(0, 8).toUpperCase()}`,
    Customer: buyer.email, CancelUrl: `${env.APP_ORIGIN}/app/orders/${o.id}?cancelled=1`, ErrorUrl: `${env.APP_ORIGIN}/app/orders/${o.id}?failed=1`,
    SuccessUrl: `${env.APP_ORIGIN}/app/orders/${o.id}`, NotifyUrl: `${env.APP_ORIGIN}/api/pay/ozow/notify`, IsTest: env.OZOW_IS_TEST === '1' ? 'true' : 'false',
  }
  // Hash order per Ozow: SiteCode, CountryCode, CurrencyCode, Amount, TransactionReference, BankReference, Optional1-5, Customer,
  // CancelUrl, ErrorUrl, SuccessUrl, NotifyUrl, IsTest, PrivateKey — concatenated, lower-cased, SHA-512.
  const raw = [f.SiteCode, f.CountryCode, f.CurrencyCode, f.Amount, f.TransactionReference, f.BankReference, '', '', '', '', '', f.Customer, f.CancelUrl, f.ErrorUrl, f.SuccessUrl, f.NotifyUrl, f.IsTest, env.OZOW_PRIVATE_KEY ?? ''].join('')
  return { action: 'https://pay.ozow.com', method: 'POST', fields: { ...f, HashCheck: await sha512Hex(raw.toLowerCase()) } }
}

/** PayFast ITN: signature must match the fields exactly as received (minus `signature`). */
export function verifyPayfastSignature(params: [string, string][], passphrase?: string): boolean {
  const sig = params.find(([k]) => k === 'signature')?.[1] ?? ''
  const rest = params.filter(([k]) => k !== 'signature')
  const parts = rest.map(([k, v]) => `${k}=${pfEncode(v.trim())}`)
  if (passphrase) parts.push(`passphrase=${pfEncode(passphrase.trim())}`)
  return sig !== '' && timingSafeEqual(md5(parts.join('&')), sig.toLowerCase())
}

const OZOW_NOTIFY_ORDER = ['SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status', 'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5', 'CurrencyCode', 'IsTest', 'StatusMessage']
export async function verifyOzowHash(p: URLSearchParams, privateKey: string): Promise<boolean> {
  const given = (p.get('Hash') ?? '').toLowerCase()
  const raw = OZOW_NOTIFY_ORDER.map(k => p.get(k) ?? '').join('') + privateKey
  return given !== '' && timingSafeEqual(await sha512Hex(raw.toLowerCase()), given)
}
