import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import type { FeeTerms } from './pricing'

/**
 * VYBE Tickets: ticket-sales review, verification evidence, door staff and admission, and the admin trust/finance views
 * (migration 28). Every write here is a database function that re-checks who is asking; nothing on this side decides
 * an outcome. Older servers without migration 28 answer null so screens can say so instead of failing.
 */
export type SalesReview = 'not_submitted' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'suspended'
export const REVIEW_LABEL: Record<SalesReview, string> = {
  not_submitted: 'Not submitted', submitted: 'Submitted', under_review: 'Under review', approved: 'Approved for sales', rejected: 'Changes needed', suspended: 'Sales suspended',
}
export type EvidenceKind = 'organiser_identity' | 'business_registration' | 'venue_authorisation' | 'lineup_confirmation' | 'other'
export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  organiser_identity: 'Who is organising', business_registration: 'Business registration', venue_authorisation: 'Venue booking or permission',
  lineup_confirmation: 'Lineup confirmation', other: 'Other',
}
export interface Evidence { id: string; kind: EvidenceKind; note: string; file_path: string | null; status: 'pending' | 'approved' | 'rejected' | 'expired'; review_reason: string; created_at: string }
export interface Decision { id: number; from_status: string; to_status: string; reason: string; created_at: string }
export interface ReviewState { status: SalesReview; note: string; reviewed_at: string | null; evidence: Evidence[]; decisions: Decision[]; terms: FeeTerms & { name: string; scope: string } | null }

const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export async function loadReview(eventId: string): Promise<ReviewState | null> {
  const ev = await supabase.from('events').select('sales_review,sales_review_note,sales_reviewed_at').eq('id', eventId).maybeSingle()
  if (ev.error) { if (isMissingSchema(ev.error)) return null; throw ev.error }
  const [evd, dec, terms] = await Promise.all([
    supabase.from('event_evidence').select('id,kind,note,file_path,status,review_reason,created_at').eq('event_id', eventId).order('created_at', { ascending: false }),
    supabase.from('event_sales_decisions').select('id,from_status,to_status,reason,created_at').eq('event_id', eventId).order('id', { ascending: false }).limit(20),
    supabase.rpc('event_fee_terms', { p_event: eventId }),
  ])
  const row = ev.data as { sales_review: SalesReview; sales_review_note: string; sales_reviewed_at: string | null } | null
  return {
    status: row?.sales_review ?? 'not_submitted', note: row?.sales_review_note ?? '', reviewed_at: row?.sales_reviewed_at ?? null,
    evidence: (evd.data ?? []) as Evidence[], decisions: (dec.data ?? []) as Decision[], terms: (terms.data ?? null) as ReviewState['terms'],
  }
}
export const addEvidence = (eventId: string, kind: EvidenceKind, note: string, filePath: string | null) => rpc<string>('add_event_evidence', { p_event: eventId, p_kind: kind, p_note: note, p_file_path: filePath })
export const submitForReview = (eventId: string, note: string) => rpc<string>('submit_event_for_sales_review', { p_event: eventId, p_note: note })

/* ---------------------------------------------------------------- door staff and admission */
export interface Staff { user_id: string; role: string; profiles: { username: string; display_name: string } | null }
export async function loadStaff(eventId: string): Promise<Staff[] | null> {
  const { data, error } = await supabase.from('event_staff').select('user_id,role,profiles:user_id(username,display_name)').eq('event_id', eventId)
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? []) as unknown as Staff[]
}
export async function addStaff(eventId: string, username: string, me: string) {
  const u = username.trim().toLowerCase().replace(/^@/, '')
  if (!u) throw new Error('Enter a username.')
  const { data: p, error: e1 } = await supabase.from('profiles').select('id').eq('username', u).maybeSingle()
  if (e1) throw e1
  if (!p) throw new Error('No one on VYBE has that username.')
  const { error } = await supabase.from('event_staff').insert({ event_id: eventId, user_id: p.id, role: 'scanner', added_by: me })
  if (error) throw new Error(error.code === '23505' ? 'They can already scan this event.' : error.message)
}
export async function removeStaff(eventId: string, userId: string) {
  const { error } = await supabase.from('event_staff').delete().eq('event_id', eventId).eq('user_id', userId)
  if (error) throw error
}
export type AdmitResult = 'ok' | 'already_used' | 'void' | 'refunded' | 'wrong_event' | 'invalid' | 'forbidden' | 'event_cancelled' | 'not_paid' | 'rate_limited'
export const ADMIT_TEXT: Record<AdmitResult, string> = {
  ok: '✓ Welcome in', already_used: '⚠ Already used', void: '✕ Ticket voided', refunded: '✕ Ticket refunded', wrong_event: '✕ Ticket for a different event',
  invalid: '✕ Not a valid ticket', forbidden: '✕ You are not on this event’s door team', event_cancelled: '✕ Event cancelled', not_paid: '✕ Order not paid', rate_limited: '⏸ Too many bad codes — wait a few minutes',
}
export const admitTicket = (eventId: string, code: string) => rpc<{ result: AdmitResult; ticket_type?: string; holder?: string; used_at?: string }>('admit_ticket', { p_event: eventId, p_code: code })
/** The ticket holder's own code (organisers and door staff never read codes). */
export async function myTicketCode(ticketId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('my_ticket_code', { p_ticket: ticketId })
  if (error) return null
  return (data as string | null) ?? null
}

/* ---------------------------------------------------------------- admin */
export interface QueueItem { id: string; title: string; starts_at: string; timezone: string; sales_review: SalesReview; sales_review_note: string; host: string; organization_id: string | null; profiles: { username: string; display_name: string } | null; organizations: { name: string; slug: string } | null }
export async function reviewQueue(statuses: SalesReview[]): Promise<QueueItem[] | null> {
  const { data, error } = await supabase.from('events').select('id,title,starts_at,timezone,sales_review,sales_review_note,host,organization_id,profiles:host(username,display_name),organizations:organization_id(name,slug)')
    .in('sales_review', statuses).order('starts_at').limit(100)
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? []) as unknown as QueueItem[]
}
export const reviewEventSales = (eventId: string, decision: SalesReview, reason: string) => rpc<string>('admin_review_event_sales', { p_event: eventId, p_decision: decision, p_reason: reason })
export const decideEvidence = (id: string, status: 'approved' | 'rejected' | 'expired', reason: string) => rpc<void>('admin_decide_evidence', { p_evidence: id, p_status: status, p_reason: reason })
export const setLineupStatus = (id: string, status: string, note: string) => rpc<void>('admin_set_lineup_status', { p_lineup: id, p_status: status, p_note: note })

export interface FeePolicy extends FeeTerms { id: string; scope: 'platform' | 'organization' | 'event'; organization_id: string | null; event_id: string | null; name: string; effective_from: string; retired_at: string | null; note: string; created_at: string }
export async function feePolicies(): Promise<FeePolicy[] | null> {
  const { data, error } = await supabase.from('fee_policies').select('*').order('created_at', { ascending: false }).limit(100)
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? []) as FeePolicy[]
}
export const createFeePolicy = (p: Partial<FeePolicy> & { note: string }) => rpc<string>('admin_create_fee_policy', { p })

export interface TicketFinance {
  basis: string; collected_cents: number; gross_ticket_sales_cents: number; commission_revenue_cents: number; buyer_fee_revenue_cents: number; vat_on_platform_charges_cents: number
  refunds_paid_cents: number; chargebacks_cents: number; chargeback_losses_cents: number; payouts_completed_cents: number; net_platform_contribution_cents: number; processing_costs: string; processing_costs_cents?: number
  balances: { cash_held_cents: number; organizer_payable_cents: number; refunds_owed_cents: number; vat_payable_cents: number }
  open_refund_obligations_cents: number; open_exceptions: number; events_awaiting_review: number
}
export const ticketFinance = (from: string, to: string) => rpc<TicketFinance>('admin_ticket_finance', { p_from: from, p_to: to })
export const reconcile = () => rpc<{ open_exceptions: number; new_exceptions: number; expired_orders: number }>('finance_reconcile', {})
export interface ExceptionCase { id: number; kind: string; ref_key: string; severity: 'low' | 'medium' | 'high' | 'critical'; order_id: string | null; refund_id: string | null; payout_id: string | null; detail: Record<string, unknown>; status: string; resolution: string; created_at: string }
export async function exceptions(status: 'open' | 'resolved' | 'dismissed'): Promise<ExceptionCase[] | null> {
  const { data, error } = await supabase.from('reconciliation_exceptions').select('*').eq('status', status).order('created_at', { ascending: false }).limit(100)
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? []) as ExceptionCase[]
}
export const resolveException = (id: number, status: 'resolved' | 'dismissed', resolution: string) => rpc<void>('admin_resolve_exception', { p_id: id, p_status: status, p_resolution: resolution })
export interface PaymentNote { id: number; provider: string; provider_txn_id: string; reported_status: string; order_ref: string; amount_cents: number | null; outcome: string; times_seen: number; last_seen_at: string }
export async function paymentNotifications(): Promise<PaymentNote[] | null> {
  const { data, error } = await supabase.from('payment_notifications').select('id,provider,provider_txn_id,reported_status,order_ref,amount_cents,outcome,times_seen,last_seen_at').order('last_seen_at', { ascending: false }).limit(50)
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? []) as PaymentNote[]
}
