import { md5 } from './md5.ts'
import type { Env } from './http.ts'

export interface OrderRow { id: string; buyer: string; event_id: string | null; status: string; provider: string | null; total_cents: number; expires_at: string; kind?: 'ticket' | 'badge' | 'sponsor' }

/** Where the buyer lands after paying: tickets go to the order page, VYBE Verified and boosts back to their own screens. */
export const returnUrl = (env: Env, o: OrderRow, suffix = '') =>
  o.kind === 'badge' ? `${env.APP_ORIGIN}/app/profile/settings/verified?order=${o.id}${suffix ? `&${suffix}` : ''}`
    : o.kind === 'sponsor' ? `${env.APP_ORIGIN}/app/boost?order=${o.id}${suffix ? `&${suffix}` : ''}`
    : `${env.APP_ORIGIN}/app/orders/${o.id}${suffix ? `?${suffix}` : ''}`

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
  const notify = `${env.SUPABASE_URL}/functions/v1/payfast-itn`
  const sandbox = env.PAYFAST_SANDBOX === '1'
  const fields: [string, string][] = [
    ['merchant_id', env.PAYFAST_MERCHANT_ID ?? ''], ['merchant_key', env.PAYFAST_MERCHANT_KEY ?? ''],
    ['return_url', returnUrl(env, o)], ['cancel_url', returnUrl(env, o, 'cancelled=1')],
    ['notify_url', notify],
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
    Customer: buyer.email, CancelUrl: returnUrl(env, o, 'cancelled=1'), ErrorUrl: returnUrl(env, o, 'failed=1'),
    SuccessUrl: returnUrl(env, o), NotifyUrl: `${env.SUPABASE_URL}/functions/v1/ozow-notify`, IsTest: env.OZOW_IS_TEST === '1' ? 'true' : 'false',
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


/** PayFast API request signature: every header + body parameter, sorted by name, URL-encoded, passphrase appended, MD5. */
export function payfastApiSignature(params: Record<string, string>, passphrase?: string): string {
  const parts = Object.keys(params).sort().filter(k => params[k] !== '').map(k => `${k}=${pfEncode(params[k].trim())}`)
  if (passphrase) parts.push(`passphrase=${pfEncode(passphrase.trim())}`)
  return md5(parts.join('&'))
}

/** PayFast timestamps are ISO-8601 without milliseconds or zone, e.g. 2026-10-21T09:30:00. */
export const payfastTimestamp = (d = new Date()) => d.toISOString().slice(0, 19)
