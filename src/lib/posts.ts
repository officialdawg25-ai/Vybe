import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import type { Post } from './types'

export const BASE_SELECT = '*, profiles:author(id,username,display_name,avatar_path), reactions(count), comments(count), mine_reaction:reactions(user_id), mine_save:saves(user_id)'
/** Adds the organization ("page") and shared-plan embeds. Needs migration 6; fetchPosts falls back to BASE_SELECT without it. */
export const POST_SELECT_6 = `${BASE_SELECT}, org:organizations!organization_id(id,name,slug), event:events!event_id(id,title,starts_at,timezone,city,venue,status)`
/** Migration 11: gallery, tagged friends, song preview and the author's verified badge. */
export const POST_SELECT = `${POST_SELECT_6.replace('profiles:author(id,username,display_name,avatar_path)', 'profiles:author(id,username,display_name,avatar_path,verified_until)')}, post_media(path,type,sort), tags:post_tags(profiles:user_id(id,username,display_name,avatar_path)), track:music_tracks!music_track_id(preview_path,artwork_path)`
export const PAGE = 15

/** Runs a post query with the richest select first and degrades when a newer migration is not applied yet. */
export async function withPostSelect<T>(run: (select: string) => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>) {
  for (const sel of [POST_SELECT, POST_SELECT_6, BASE_SELECT]) {
    const r = await run(sel)
    if (!r.error || !isMissingSchema(r.error)) return r
  }
  return run(BASE_SELECT)
}

export async function fetchPosts(opts: { uid: string; cursor?: string; authors?: string[]; communityId?: string; author?: string; ids?: string[]; or?: string; publicOnly?: boolean; excludeAuthors?: string[]; matching?: string; pagesOnly?: boolean; withEvent?: boolean; organizationId?: string }) {
  const build = (select: string) => {
  let q = supabase.from('posts').select(select).eq('mine_reaction.user_id', opts.uid).order('created_at', { ascending: false }).limit(PAGE)
  if (opts.cursor) q = q.lt('created_at', opts.cursor)
  if (opts.authors) q = q.in('author', opts.authors)
  if (opts.ids) q = q.in('id', opts.ids)
  if (opts.author) q = q.eq('author', opts.author)
  if (opts.communityId) q = q.eq('community_id', opts.communityId)
  if (opts.or) q = q.or(opts.or)
  if (opts.publicOnly) q = q.eq('visibility', 'public')
  if (opts.excludeAuthors?.length) q = q.not('author', 'in', `(${opts.excludeAuthors.join(',')})`)
  if (opts.matching) q = q.ilike('body', `%${opts.matching}%`)
  if (opts.organizationId) q = q.eq('organization_id', opts.organizationId)
  if (opts.pagesOnly) q = q.not('organization_id', 'is', null)
  if (opts.withEvent) q = q.not('event_id', 'is', null)
  return q
  }
  let { data, error } = await build(POST_SELECT)
  if (error && isMissingSchema(error)) ({ data, error } = await build(POST_SELECT_6))   // migration 11 not applied yet
  if (error && isMissingSchema(error)) ({ data, error } = await build(BASE_SELECT))     // database not migrated yet: plain feed
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

/** Communities the user actively belongs to (pending join requests do not count). */
export async function myCommunityIds(uid: string): Promise<string[]> {
  const { data, error } = await supabase.from('community_members').select('community_id').eq('user_id', uid).eq('status', 'active').limit(200)
  if (error) throw error
  return (data ?? []).map(r => r.community_id)
}
