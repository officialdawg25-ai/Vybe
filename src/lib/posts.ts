import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import type { Post } from './types'

export const BASE_SELECT = '*, profiles:author(id,username,display_name,avatar_path), reactions(count), comments(count), mine_reaction:reactions(user_id), mine_save:saves(user_id)'
/** Adds the organization ("page") and shared-plan embeds. Needs migration 6; fetchPosts falls back to BASE_SELECT without it. */
export const POST_SELECT_6 = `${BASE_SELECT}, org:organizations!organization_id(id,name,slug), event:events!event_id(id,title,starts_at,timezone,city,venue,status)`
/** Migration 11: gallery, tagged friends, song preview and the author's verified badge. */
export const POST_SELECT = `${POST_SELECT_6.replace('profiles:author(id,username,display_name,avatar_path)', 'profiles:author(id,username,display_name,avatar_path,verified_until)')}, post_media(path,type,sort,poster_path,display_path), tags:post_tags(profiles:user_id(id,username,display_name,avatar_path)), track:music_tracks!music_track_id(preview_path,artwork_path)`
/** The same without photo display copies (migration 25 not applied yet). */
const POST_SELECT_24 = POST_SELECT.replace('post_media(path,type,sort,poster_path,display_path)', 'post_media(path,type,sort,poster_path)')
/** The same without video posters (migration 20 not applied yet). */
const POST_SELECT_19 = POST_SELECT.replace('post_media(path,type,sort,poster_path,display_path)', 'post_media(path,type,sort)')
export const PAGE = 15

/**
 * Feed position: the last post's time and id. Pages are ordered by (created_at, id) newest first — the same order as the
 * posts_created_idx index — so posts that share a timestamp are never skipped or shown twice between pages.
 */
export const cursorOf = (p: { created_at: string; id: string }) => `${p.created_at}|${p.id}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** PostgREST filter for "older than the cursor". Values are validated and quoted (timestamps contain reserved characters). */
export function cursorFilter(cursor: string): { or: string } | { lt: string } | null {
  const [ts, id] = cursor.split('|')
  if (!ts || Number.isNaN(Date.parse(ts))) return null
  if (!id || !UUID.test(id)) return { lt: ts }                             // time only (an older cursor); an odd id never reaches the filter
  return { or: `created_at.lt."${ts}",and(created_at.eq."${ts}",id.lt.${id})` }
}

/** Runs a post query with the richest select first and degrades when a newer migration is not applied yet. */
export async function withPostSelect<T>(run: (select: string) => PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>) {
  for (const sel of [POST_SELECT, POST_SELECT_24, POST_SELECT_19, POST_SELECT_6, BASE_SELECT]) {
    const r = await run(sel)
    if (!r.error || !isMissingSchema(r.error)) return r
  }
  return run(BASE_SELECT)
}

export async function fetchPosts(opts: { uid: string; reels?: boolean; cursor?: string; authors?: string[]; communityId?: string; author?: string; ids?: string[]; or?: string; publicOnly?: boolean; excludeAuthors?: string[]; matching?: string; pagesOnly?: boolean; withEvent?: boolean; organizationId?: string }) {
  const build = (select: string) => {
  let q = supabase.from('posts').select(select).eq('mine_reaction.user_id', opts.uid).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE)
  const c = opts.cursor ? cursorFilter(opts.cursor) : null
  if (opts.cursor && !c) throw new Error('Invalid feed position.')
  if (c && 'lt' in c) q = q.lt('created_at', c.lt)
  if (opts.authors) q = q.in('author', opts.authors)
  if (opts.ids) q = q.in('id', opts.ids)
  if (opts.author) q = q.eq('author', opts.author)
  if (opts.communityId) q = q.eq('community_id', opts.communityId)
  // Two OR groups must both hold: combined into one so PostgREST cannot read them as alternatives.
  if (c && 'or' in c) q = opts.or ? q.or(`and(or(${c.or}),or(${opts.or}))`) : q.or(c.or)
  else if (opts.or) q = q.or(opts.or)
  if (opts.publicOnly) q = q.eq('visibility', 'public')
  if (opts.excludeAuthors?.length) q = q.not('author', 'in', `(${opts.excludeAuthors.join(',')})`)
  if (opts.matching) q = q.ilike('body', `%${opts.matching}%`)
  if (opts.organizationId) q = q.eq('organization_id', opts.organizationId)
  if (opts.pagesOnly) q = q.not('organization_id', 'is', null)
  if (opts.withEvent) q = q.not('event_id', 'is', null)
  if (opts.reels) q = q.eq('is_reel', true)
  return q
  }
  let { data, error } = await build(POST_SELECT)
  if (error && isMissingSchema(error)) ({ data, error } = await build(POST_SELECT_24))  // migration 25 not applied yet
  if (error && isMissingSchema(error)) ({ data, error } = await build(POST_SELECT_19))  // migration 20 not applied yet
  if (error && isMissingSchema(error)) ({ data, error } = await build(POST_SELECT_6))   // migration 11 not applied yet
  if (error && isMissingSchema(error)) ({ data, error } = await build(BASE_SELECT))     // database not migrated yet: plain feed
  if (error) throw error
  return (data ?? []) as unknown as Post[]
}

/**
 * Opening the app on Home: the first page of the main feed is requested while the profile check and Home's own code are
 * still loading, instead of after them. It is tied to the signed-in account, used once, and only for 15 seconds; anything
 * else (another account, a later visit, a failure) simply asks the server again. Row Level Security applies as always.
 */
let warm: { uid: string; at: number; p: Promise<Post[]> } | null = null
export function prefetchFirstPage(uid: string) {
  if (warm?.uid === uid && Date.now() - warm.at < 15_000) return
  const p = fetchPosts({ uid }); p.catch(() => {})
  warm = { uid, at: Date.now(), p }
}
export function takeFirstPage(uid: string): Promise<Post[]> | null {
  const w = warm; warm = null
  return w && w.uid === uid && Date.now() - w.at < 15_000 ? w.p : null
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
