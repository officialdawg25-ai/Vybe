import { supabase } from './supabase'
import { callFunction } from './functions'
import { money } from './tickets'

export { money }
export interface Balance { gross_sales_cents: number; settled_sales_cents: number; refunds_and_chargebacks_cents: number; paid_out_cents: number; pending_payout_cents: number; open_disputes_cents: number; balance_cents: number; available_cents: number; min_payout_cents: number; hold_days: number }
export interface RefundRow { id: string; order_id: string; kind: string; status: string; ticket_amount_cents: number; fee_amount_cents: number; reason: string; error: string | null; created_at: string; provider_ref?: string | null; orders?: { id: string; event_id: string; buyer: string; total_cents: number; events: { title: string } | null; profiles?: { username: string; display_name: string } | null } }

export const REFUND_LABEL: Record<string, string> = { requested: 'Waiting for the organizer', approved: 'Approved — processing', processing: 'Processing', succeeded: 'Refunded', failed: 'Failed', rejected: 'Declined', manual_required: 'Approved — being completed by VYBE staff' }

/** Hands an approved refund to the edge function (it talks to the payment provider). Returns the outcome. */
export async function processRefund(refundId: string): Promise<'succeeded' | 'manual_required'> {
  const r = await callFunction<{ status: 'succeeded' | 'manual_required' }>('refund-process', { refund_id: refundId })
  return r.status
}

export async function requestRefund(orderId: string, reason: string, tickets?: string[]) {
  const { data, error } = await supabase.rpc('request_refund', { p_order: orderId, p_reason: reason, p_tickets: tickets ?? null })
  if (error) throw new Error(error.message)
  const r = data as { id: string; status: string; ticket_amount_cents: number }
  if (r.status === 'approved') { try { await processRefund(r.id) } catch { /* the queue retries; the refund stays approved */ } }
  return r
}

/** Processes every approved refund for an event (used after cancelling it). Returns counts. */
export async function processApprovedForEvent(eventId: string) {
  const { data } = await supabase.from('refunds').select('id,orders!inner(event_id)').eq('status', 'approved').eq('orders.event_id', eventId).limit(500)
  let done = 0, manual = 0, failed = 0
  for (const r of (data ?? []) as { id: string }[]) {
    try { (await processRefund(r.id)) === 'succeeded' ? done++ : manual++ } catch { failed++ }
  }
  return { done, manual, failed }
}

export function toCsv(rows: (string | number)[][]) {
  return rows.map(r => r.map(c => { const s = String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }).join(',')).join('\n')
}
export function download(name: string, content: string, type = 'text/csv') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href)
}
