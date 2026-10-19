import { supabase } from './supabase'

export interface Rel { id: string; status: 'pending' | 'accepted'; outgoing: boolean }

/** One query for the whole graph around the user; callers look relations up by other-user id. */
export async function loadRelations(uid: string): Promise<Map<string, Rel>> {
  const { data, error } = await supabase.from('friendships').select('id,requester,addressee,status').limit(1000)
  if (error) throw error
  const m = new Map<string, Rel>()
  for (const r of data ?? []) m.set(r.requester === uid ? r.addressee : r.requester, { id: r.id, status: r.status, outgoing: r.requester === uid })
  return m
}

export const INTERESTS = ['Music', 'Food', 'Fitness', 'Outdoors', 'Art', 'Tech', 'Gaming', 'Travel', 'Film', 'Books', 'Nightlife', 'Wellness', 'Sport', 'Fashion', 'Volunteering']
