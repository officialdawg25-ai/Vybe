import { supabase } from './supabase'
import { callFunction } from './functions'

export interface TicketType {
  id: string; event_id: string; name: string; description: string; kind: 'single' | 'group'; group_size: number
  price_cents: number; quantity_total: number; max_per_order: number; sales_start: string | null; sales_end: string | null; status: 'active' | 'paused'; sort: number
  /** Branding (migration 32); absent on older servers. */
  tier?: TierKey; accent?: string | null; design?: TicketDesign; perks?: string[]
  /** Seating (migrations 43/44); absent on older servers. 'buyer' means the buyer picks seats on a map before checkout. */
  seating?: 'none' | 'reserved'; seat_selection?: 'auto' | 'buyer'
}
export type TierKey = 'general' | 'early_bird' | 'vip' | 'vvip' | 'backstage' | 'student' | 'table' | 'group'
export type TicketDesign = 'aurora' | 'foil' | 'mesh' | 'minimal'
export type Provider = 'payfast' | 'ozow'
export interface OrderResult { id: string; status: string; total_cents: number; fee_cents: number; subtotal_cents: number; expires_at: string }
export interface Checkout { action: string; method: 'POST'; fields: Record<string, string> }

/** True when a table/column from a newer migration does not exist yet, so features degrade instead of erroring. */
export const isMissingSchema = (e: { code?: string; message?: string } | null) => Boolean(e && (['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'].includes(e.code ?? '') || /does not exist|schema cache/i.test(e.message ?? '')))

export const money = (cents: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100)

/** Open / closed / upcoming from the sale window and status. Pure so it can be tested. */
export function saleState(t: Pick<TicketType, 'status' | 'sales_start' | 'sales_end'>, now = Date.now()): 'on_sale' | 'paused' | 'soon' | 'closed' {
  if (t.status === 'paused') return 'paused'
  if (t.sales_start && new Date(t.sales_start).getTime() > now) return 'soon'
  if (t.sales_end && new Date(t.sales_end).getTime() < now) return 'closed'
  return 'on_sale'
}

export async function loadTicketTypes(eventId: string): Promise<(TicketType & { left: number })[]> {
  const { data, error } = await supabase.from('ticket_types').select('*').eq('event_id', eventId).order('sort').order('price_cents')
  if (error) { if (isMissingSchema(error)) return []; throw error }
  const types = (data ?? []) as TicketType[]
  const taken = await Promise.all(types.map(async t => { const r = await supabase.rpc('ticket_units_taken', { tt: t.id }); return Number(r.data ?? 0) }))
  return types.map((t, i) => ({ ...t, left: Math.max(0, t.quantity_total - taken[i]) }))
}

/** One idempotency key per checkout attempt: a double tap or a retry after a network error can never create two orders. */
export const newIdempotencyKey = () => `co-${crypto.randomUUID()}`

/** `ref` is a promoter code (migration 29); servers without it get the 4-argument call, so a code never blocks a purchase. */
export async function createOrder(eventId: string, items: { ticket_type_id: string; qty: number }[], provider: Provider, key: string, ref?: string | null): Promise<OrderResult> {
  const args = { p_event: eventId, p_items: items, p_provider: provider, p_idem: key }
  let { data, error } = await supabase.rpc('create_order', ref ? { ...args, p_ref: ref } : args)
  if (error && ref && (error.code === 'PGRST202' || /could not find the function/i.test(error.message))) ({ data, error } = await supabase.rpc('create_order', args))
  if (error) throw new Error(error.message)
  return data as OrderResult
}

export const startPayment = (orderId: string) => callFunction<Checkout>('pay-start', { order_id: orderId })

/** Hands the browser to the payment provider with a form POST (both gateways require it). */
export function submitCheckout(c: Checkout) {
  const f = document.createElement('form'); f.method = c.method; f.action = c.action; f.style.display = 'none'
  for (const [k, v] of Object.entries(c.fields)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i) }
  document.body.appendChild(f); f.submit()
}

/* ---------------------------------------------------------------- seat selection (migration 44) */
export interface SeatMapSeat { id: string; section: string; block: string; row: string; seat: string; zone: string | null; accessible: boolean; restricted_view: boolean; state: 'available' | 'held' | 'sold' | 'blocked' | 'mine' }
export interface SeatMap { types: { id: string; name: string; price_cents: number; max_per_order: number; zones: string[] }[]; zones: { id: string; name: string; kind: string }[]; seats: SeatMapSeat[]; hold_minutes: number; my_hold_expires_at: string | null }
export async function seatMap(eventId: string): Promise<SeatMap | null> {
  const { data, error } = await supabase.rpc('seat_map', { p_event: eventId })
  if (error) { if (isMissingSchema(error) || error.code === 'PGRST202') return null; throw new Error(error.message) }
  return (data ?? null) as SeatMap | null
}
export async function holdSeats(eventId: string, typeId: string, seatIds: string[]): Promise<{ expires_at: string; seats: string[] }> {
  const { data, error } = await supabase.rpc('hold_seats', { p_event: eventId, p_ticket_type: typeId, p_seats: seatIds })
  if (error) throw new Error(error.message)
  return data as { expires_at: string; seats: string[] }
}
export const releaseSeatHolds = (eventId: string) => supabase.rpc('release_my_seat_holds', { p_event: eventId })
/** Checkout when some lines are seats the buyer chose and is holding; same pricing, limits and idempotency as createOrder. */
export async function createSeatedOrder(eventId: string, items: { ticket_type_id: string; qty: number }[], provider: Provider, key: string, ref?: string | null): Promise<OrderResult & { seats?: string[] }> {
  const { data, error } = await supabase.rpc('create_seated_order', { p_event: eventId, p_items: items, p_provider: provider, p_idem: key, p_ref: ref ?? null })
  if (error) throw new Error(error.message)
  return data as OrderResult & { seats?: string[] }
}
