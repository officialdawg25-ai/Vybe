import { supabase } from './supabase'
import { isMissingSchema } from './tickets'

/**
 * Sponsored posts ("Boost"): client side of migration 36. Prices, review, delivery, frequency caps and refunds are all
 * decided in the database; this file only asks, and presents what it says.
 */
export type Goal = 'engage' | 'profile' | 'link' | 'plan'
export type SponsorStatus = 'awaiting_payment' | 'in_review' | 'live' | 'paused' | 'rejected' | 'ended' | 'cancelled'

export interface BoostPackage { id: string; label: string; days: number; price_cents: number; active?: boolean; sort?: number }
export interface Sponsorship {
  id: string; post_id: string; package_id: string; days: number; total_cents: number; goal: Goal; cta_label: string | null; cta_url: string | null
  audience_city: string | null; audience_interests: string[]; status: SponsorStatus; review_note: string | null
  starts_at: string | null; ends_at: string | null; paid_at: string | null; refund_due_cents: number; refunded_at: string | null; created_at: string
}
/** What delivery says about one ad shown to this member. */
export interface AdInfo { id: string; post_id: string; goal: Goal; cta_label: string | null; cta_url: string | null; sponsor: string; audience_city?: string | null; audience_interests?: string[] }

export const GOALS: { id: Goal; title: string; hint: string }[] = [
  { id: 'engage', title: 'More engagement', hint: 'Likes, comments and shares on this post' },
  { id: 'profile', title: 'More profile visits', hint: 'A "View profile" button under the post' },
  { id: 'link', title: 'Visit a website', hint: 'A button to your own secure link (tickets, a shop, a sign-up)' },
  { id: 'plan', title: 'Promote a plan', hint: 'A "View plan" button (the post must have a plan attached)' },
]

/** The label members see on a boosted post. Always present; never configurable by the sponsor. */
export const SPONSORED_LABEL = 'Sponsored'

export const STATUS_TEXT: Record<SponsorStatus, string> = {
  awaiting_payment: 'Waiting for payment', in_review: 'In review', live: 'Running', paused: 'Paused', rejected: 'Not approved', ended: 'Finished', cancelled: 'Cancelled',
}
/** A boost whose end time has passed is finished even if nothing has rewritten its row yet. */
export const effectiveStatus = (s: Pick<Sponsorship, 'status' | 'ends_at'>, now = Date.now()): SponsorStatus =>
  s.status === 'live' && s.ends_at && Date.parse(s.ends_at) <= now ? 'ended' : s.status

/** After which post (0-based) the n-th ad goes: after the 6th post, then every 8, so posts always lead (suggestion rails use 4, 12, 20…). */
export const adSlot = (index: number) => (index >= 5 && (index - 5) % 8 === 0 ? (index - 5) / 8 : -1)

export async function loadPackages(): Promise<BoostPackage[]> {
  const { data, error } = await supabase.from('boost_packages').select('id,label,days,price_cents,sort').eq('active', true).order('sort')
  if (error) { if (isMissingSchema(error)) return []; throw error }
  return (data ?? []) as BoostPackage[]
}

/** Boosts this member may see now (the database applies audience, blocks, hides and the daily frequency cap). Fails soft. */
export async function boostFeed(placement: 'home' | 'discover', limit = 3): Promise<AdInfo[]> {
  const { data, error } = await supabase.rpc('sponsored_feed', { p_placement: placement, p_limit: limit })
  if (error) return []
  return (Array.isArray(data) ? data : []) as AdInfo[]
}
/** One impression / one click is counted per member per day by the database; this never throws. */
export const trackAd = (id: string, kind: 'impression' | 'click') => { void supabase.rpc('track_sponsored', { p_id: id, p_kind: kind }).then(() => {}, () => {}) }

export interface Why { city: string | null; interests: string[]; sponsor_name: string | null }
export async function whyAd(id: string): Promise<Why | null> {
  const { data } = await supabase.rpc('sponsored_why', { p_id: id })
  return (data ?? null) as Why | null
}
export async function hideAd(id: string) {
  const { error } = await supabase.rpc('hide_sponsored', { p_id: id })
  if (error) throw error
}

export interface Totals { impressions: number; clicks: number; reach: number }
export const ctr = (t: Totals) => (t.impressions > 0 ? Math.round((t.clicks / t.impressions) * 1000) / 10 : 0)

/** Only secure links can be set on a boost (the database checks the same rule). */
export const isSecureLink = (u: string) => /^https:\/\/[^\s]+$/.test(u.trim()) && u.trim().length >= 12 && u.trim().length <= 500
