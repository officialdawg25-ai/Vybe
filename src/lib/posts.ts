import { supabase } from './supabase'
import type { Post } from './types'

export const POST_SELECT =
  '*, profiles:author(id,username,display_name,avatar_path), reactions(count), comments(count), mine_reaction:reactions(user_id), mine_save:saves(user_id)'
export const PAGE = 15

export async function fetchPosts(opts: { uid: string; cursor?: string; authors?: string[]; communityId?: string; author?: string; ids?: string[] }) {
  let q = supabase.from('posts').select(POST_SELECT).eq('mine_reaction.user_id', opts.uid).order('created_at', { ascending: false }).limit(PAGE)
  if (opts.cursor) q = q.lt('created_at', opts.cursor)
  if (opts.authors) q = q.in('author', opts.authors)
  if (opts.ids) q = q.in('id', opts.ids)
  if (opts.author) q = q.eq('author', opts.author)
  if (opts.communityId) q = q.eq('community_id', opts.communityId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as Post[]
}

/** Accepted friends' ids (the single social graph lives in `friendships`). */
export async function friendIds(uid: string): Promise<string[]> {
  const { data, error } = await supabase.from('friendships').select('requester,addressee').eq('status', 'accepted').limit(1000)
  if (error) throw error
  return (data ?? []).map(r => (r.requester === uid ? r.addressee : r.requester))
}

export async function sharePost(id: string, text: string) {
  const url = `${window.location.origin}/app/posts/${id}`
  if (navigator.share) {
    try { await navigator.share({ url, text }); return 'shared' } catch { return 'cancelled' }
  }
  await navigator.clipboard.writeText(url)
  return 'copied'
}

export async function savedIds(): Promise<string[]> {
  const { data, error } = await supabase.from('saves').select('post_id').order('created_at', { ascending: false }).limit(200)
  if (error) throw error
  return (data ?? []).map(r => r.post_id)
}
