import { supabase } from './supabase'
import { isMissingSchema } from './tickets'

/**
 * VYBE Tickets, migration 28: event reviews and complaints, promoter links, payout holds, material changes, exports,
 * and the admin risk queue. Every write is a database function that re-checks who is asking. Servers without
 * migration 28 answer null so screens can hide themselves instead of failing.
 */
const rpc = async <T>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}
/** Function missing on this server (PostgREST cannot find it), as opposed to a refusal. */
const missingFn = (e: { code?: string; message?: string } | null) => Boolean(e && (e.code === 'PGRST202' || isMissingSchema(e) || /could not find the function/i.test(e.message ?? '')))
const optional = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<T | null> => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) { if (missingFn(error)) return null; throw new Error(error.message) }
  return data as T
}

/* ---------------------------------------------------------------- promoter attribution in checkout */
const REF_KEY = (eventId: string) => `vybe.ref.${eventId}`
export const isReferralCode = (s: string | null | undefined): s is string => Boolean(s && /^[A-Z0-9]{8}$/.test(s))
/** Remember a promoter code that brought the buyer to this event (per tab, never shared). */
export function rememberReferral(eventId: string, code: string | null) {
  const c = code?.trim().toUpperCase()
  if (!isReferralCode(c)) return
  try { sessionStorage.setItem(REF_KEY(eventId), c) } catch { /* storage unavailable: attribution is best effort */ }
}
export function referralFor(eventId: string): string | null {
  try { const c = sessionStorage.getItem(REF_KEY(eventId)); return isReferralCode(c) ? c : null } catch { return null }
}
export const promoterUrl = (eventId: string, code: string, origin = window.location.origin) => `${origin}/app/plans/${eventId}?ref=${code}`

/* ---------------------------------------------------------------- reviews */
export interface Review { id: string; event_id: string; author: string; rating: number; body: string; verified_attendee: boolean; status: 'published' | 'hidden'; moderation_note: string; organiser_response: string; responded_at: string | null; created_at: string; profiles: { username: string; display_name: string } | null }
export interface ReviewSummary { count: number; verified: number; average: number | null }
export type Eligibility = { eligible: true; verified_attendee: boolean } | { eligible: false; reason: 'not_found' | 'organiser' | 'no_ticket' | 'not_over' | 'too_late' }
export const ELIGIBILITY_TEXT: Record<string, string> = {
  organiser: 'Organisers can’t review their own events.', no_ticket: 'Only people who held a ticket can review this event.',
  not_over: 'You can review once the event is over.', too_late: 'Reviews closed 60 days after the event.', not_found: '',
}
const REVIEW_COLS = 'id,event_id,author,rating,body,verified_attendee,status,moderation_note,organiser_response,responded_at,created_at,profiles:author(username,display_name)'
export async function loadReviews(eventId: string): Promise<{ summary: ReviewSummary; reviews: Review[]; eligibility: Eligibility } | null> {
  const [s, r, el] = await Promise.all([
    supabase.rpc('event_review_summary', { p_event: eventId }),
    supabase.from('event_reviews').select(REVIEW_COLS).eq('event_id', eventId).order('created_at', { ascending: false }).limit(50),
    supabase.rpc('review_eligibility', { p_event: eventId }),
  ])
  if (s.error) { if (missingFn(s.error)) return null; throw new Error(s.error.message) }
  if (r.error) throw new Error(r.error.message)
  if (!s.data) return null
  return { summary: s.data as ReviewSummary, reviews: (r.data ?? []) as unknown as Review[], eligibility: (el.data ?? { eligible: false, reason: 'not_found' }) as Eligibility }
}
export const submitReview = (eventId: string, rating: number, body: string) => rpc<string>('submit_event_review', { p_event: eventId, p_rating: rating, p_body: body })
export const respondToReview = (reviewId: string, text: string) => rpc<void>('respond_to_review', { p_review: reviewId, p_text: text })
export const moderateReview = (reviewId: string, status: 'published' | 'hidden', note: string) => rpc<void>('admin_moderate_review', { p_review: reviewId, p_status: status, p_note: note })
export async function recentReviews(status: 'published' | 'hidden'): Promise<(Review & { events: { title: string } | null })[] | null> {
  const { data, error } = await supabase.from('event_reviews').select(`${REVIEW_COLS},events:event_id(title)`).eq('status', status).order('created_at', { ascending: false }).limit(50)
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  return (data ?? []) as unknown as (Review & { events: { title: string } | null })[]
}

/* ---------------------------------------------------------------- complaints */
export type ComplaintStatus = 'open' | 'answered' | 'escalated' | 'closed'
export interface Complaint { id: string; event_id: string; author: string; order_id: string | null; subject: string; body: string; status: ComplaintStatus; organiser_reply: string; replied_at: string | null; resolution: string; created_at: string; profiles: { username: string; display_name: string } | null; events?: { title: string } | null }
export const COMPLAINT_LABEL: Record<ComplaintStatus, string> = { open: 'Waiting for the organiser', answered: 'Organiser replied', escalated: 'With VYBE', closed: 'Closed' }
const COMPLAINT_COLS = 'id,event_id,author,order_id,subject,body,status,organiser_reply,replied_at,resolution,created_at,profiles:author(username,display_name)'
export async function loadComplaints(eventId: string): Promise<Complaint[] | null> {
  const { data, error } = await supabase.from('event_complaints').select(COMPLAINT_COLS).eq('event_id', eventId).order('created_at', { ascending: false }).limit(100)
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  return (data ?? []) as unknown as Complaint[]
}
export async function escalatedComplaints(): Promise<Complaint[] | null> {
  const { data, error } = await supabase.from('event_complaints').select(`${COMPLAINT_COLS},events:event_id(title)`).eq('status', 'escalated').order('created_at').limit(100)
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  return (data ?? []) as unknown as Complaint[]
}
export const submitComplaint = (eventId: string, subject: string, body: string) => rpc<string>('submit_complaint', { p_event: eventId, p_subject: subject, p_body: body })
export const replyComplaint = (id: string, text: string) => rpc<void>('reply_complaint', { p_complaint: id, p_text: text })
export const escalateComplaint = (id: string) => rpc<void>('escalate_complaint', { p_complaint: id })
export const closeComplaint = (id: string, resolution: string) => rpc<void>('admin_close_complaint', { p_complaint: id, p_resolution: resolution })

/* ---------------------------------------------------------------- promoter links */
export interface PromoterLink { id: string; promoter: string; code: string; commission_bps: number; active: boolean; created_at: string; profiles: { username: string; display_name: string } | null }
export interface Attribution { link_id: string; commission_cents: number; reversed_cents: number }
export async function loadPromoterLinks(eventId: string): Promise<{ links: PromoterLink[]; byLink: Map<string, { orders: number; earned: number }> } | null> {
  const { data, error } = await supabase.from('promoter_links').select('id,promoter,code,commission_bps,active,created_at,profiles:promoter(username,display_name)').eq('event_id', eventId).order('created_at')
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  const links = (data ?? []) as unknown as PromoterLink[]
  const byLink = new Map<string, { orders: number; earned: number }>()
  if (links.length) {
    const a = await supabase.from('referral_attributions').select('link_id,commission_cents,reversed_cents').in('link_id', links.map(l => l.id))
    for (const r of (a.data ?? []) as Attribution[]) {
      const x = byLink.get(r.link_id) ?? { orders: 0, earned: 0 }
      x.orders += 1; x.earned += Number(r.commission_cents) - Number(r.reversed_cents); byLink.set(r.link_id, x)
    }
  }
  return { links, byLink }
}
export const createPromoterLink = (eventId: string, username: string, bps: number) => rpc<{ id: string; code: string; commission_bps: number }>('create_promoter_link', { p_event: eventId, p_username: username, p_commission_bps: bps })
export const setPromoterLinkActive = (id: string, active: boolean) => rpc<void>('set_promoter_link_active', { p_link: id, p_active: active })
export interface Earning { link: string; code: string; event_id: string; event: string; commission_bps: number; active: boolean; orders: number; earned_cents: number }
export const myPromoterEarnings = () => optional<Earning[]>('my_promoter_earnings')

/* ---------------------------------------------------------------- organiser tools */
export const declareMaterialChange = (eventId: string, note: string) => rpc<number>('declare_material_change', { p_event: eventId, p_note: note })
export interface SalesRow { order: string; created_at: string; paid_at: string | null; status: string; provider: string; tickets: number; ticket_subtotal_cents: number; buyer_fee_cents: number; commission_cents: number | null; organizer_net_cents: number | null; refunded_cents: number; promoter_code: string | null }
export interface DoorRow { holder: string; ticket_type: string; status: string; checked_in_at: string | null }
export const salesExport = (eventId: string) => rpc<SalesRow[]>('event_sales_export', { p_event: eventId })
export const doorList = (eventId: string) => rpc<DoorRow[]>('event_door_list', { p_event: eventId })
const rand = (c: number | null | undefined) => ((Number(c ?? 0)) / 100).toFixed(2)
/** CSV rows for the sales export: amounts in rand with two decimals, from integer cents (no float sums). */
export function salesCsvRows(rows: SalesRow[]): (string | number)[][] {
  return [['Order', 'Created', 'Paid', 'Status', 'Provider', 'Tickets', 'Ticket subtotal (ZAR)', 'Buyer fee (ZAR)', 'VYBE commission (ZAR)', 'Your net (ZAR)', 'Refunded (ZAR)', 'Promoter code'],
    ...rows.map(r => [r.order, r.created_at, r.paid_at ?? '', r.status, r.provider, r.tickets, rand(r.ticket_subtotal_cents), rand(r.buyer_fee_cents), rand(r.commission_cents), rand(r.organizer_net_cents ?? r.ticket_subtotal_cents), rand(r.refunded_cents), r.promoter_code ?? ''])]
}
export function doorCsvRows(rows: DoorRow[]): (string | number)[][] {
  return [['Name', 'Ticket', 'Status', 'Checked in'], ...rows.map(r => [r.holder, r.ticket_type, r.status, r.checked_in_at ?? ''])]
}

/* ---------------------------------------------------------------- payout holds */
export interface Hold { id: number; since: string; status: 'open' | 'appealed'; appealed: boolean }
export const myPayoutHolds = (orgId: string | null) => optional<Hold[]>('my_payout_holds', { p_org: orgId })
export const appealHold = (id: number, text: string) => rpc<void>('appeal_payout_hold', { p_case: id, p_text: text })

/* ---------------------------------------------------------------- admin risk */
export type RiskAction = 'MONITOR' | 'REQUIRE_ADDITIONAL_VERIFICATION' | 'REQUIRE_MANUAL_REVIEW' | 'LIMIT_SALES' | 'PAUSE_PAYOUT' | 'SUSPEND_EVENT' | 'RESTRICT_ACCOUNT' | 'ESCALATE_TO_TRUST_TEAM'
export const RISK_ACTIONS: RiskAction[] = ['MONITOR', 'REQUIRE_ADDITIONAL_VERIFICATION', 'REQUIRE_MANUAL_REVIEW', 'LIMIT_SALES', 'PAUSE_PAYOUT', 'SUSPEND_EVENT', 'RESTRICT_ACCOUNT', 'ESCALATE_TO_TRUST_TEAM']
/** Which actions the server enforces automatically while a case is open; the rest only queue the case for a person. */
export const ENFORCED: Partial<Record<RiskAction, string>> = { PAUSE_PAYOUT: 'Payouts held while open', RESTRICT_ACCOUNT: 'Purchases blocked while open' }
export interface RiskRule { key: string; description: string; enabled: boolean; threshold: number; window_minutes: number; action: RiskAction; updated_at: string }
export interface RiskCase { id: number; rule_key: string; subject_type: 'user' | 'organization' | 'event' | 'order'; subject_id: string; action: RiskAction; status: 'open' | 'monitoring' | 'appealed' | 'actioned' | 'dismissed'; evidence: Record<string, unknown>; appeal: string; decision_note: string; created_at: string; decided_at: string | null }
export async function riskCases(open: boolean): Promise<RiskCase[] | null> {
  const q = supabase.from('risk_cases').select('id,rule_key,subject_type,subject_id,action,status,evidence,appeal,decision_note,created_at,decided_at').order('created_at', { ascending: false }).limit(100)
  const { data, error } = await (open ? q.in('status', ['open', 'appealed', 'monitoring']) : q.in('status', ['actioned', 'dismissed']))
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  return (data ?? []) as RiskCase[]
}
export async function riskRules(): Promise<RiskRule[] | null> {
  const { data, error } = await supabase.from('risk_rules').select('key,description,enabled,threshold,window_minutes,action,updated_at').order('key')
  if (error) { if (isMissingSchema(error)) return null; throw new Error(error.message) }
  return (data ?? []) as RiskRule[]
}
export const decideRiskCase = (id: number, status: 'monitoring' | 'actioned' | 'dismissed', note: string) => rpc<void>('admin_decide_risk_case', { p_case: id, p_status: status, p_note: note })
export const setRiskRule = (key: string, enabled: boolean, threshold: number, windowMinutes: number, action: RiskAction) =>
  rpc<void>('admin_set_risk_rule', { p_key: key, p_enabled: enabled, p_threshold: threshold, p_window: windowMinutes, p_action: action })
export const subjectLink = (c: Pick<RiskCase, 'subject_type' | 'subject_id'>) => c.subject_type === 'event' ? `/app/plans/${c.subject_id}` : null
