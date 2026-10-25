import { currentPolicy } from './dataMode'
import type { Post } from './types'

/**
 * In-memory snapshots of feeds, so going back to Home shows what was there at once (and where you were) while the server is
 * asked for what is new. Never persisted: nothing survives a reload or sign-out, and every snapshot is keyed by account.
 * The server stays authoritative — a snapshot is only ever shown until its refresh arrives, then reconciled with it.
 */
export interface FeedSnapshot { posts: Post[]; done: boolean; scrollY: number }
const store = new Map<string, FeedSnapshot>()
const MAX_KEPT = 120          // posts kept per feed; older ones are fetched again when scrolled to

export const readFeed = (key?: string) => (key ? store.get(key) : undefined)
export function writeFeed(key: string | undefined, snap: FeedSnapshot) {
  if (!key) return
  store.set(key, { ...snap, posts: snap.posts.slice(0, MAX_KEPT), done: snap.done && snap.posts.length <= MAX_KEPT })
}
export const clearFeeds = () => store.clear()

/**
 * A fresh first page from the server, followed by the older posts we already had that the server says are still visible.
 * Posts that were deleted or hidden since (not in `stillVisible`) are dropped, and nothing older than the fresh page is
 * assumed: if the fresh page is short, it is everything there is.
 */
export function reconcile(fresh: Post[], cached: Post[], stillVisible: ReadonlySet<string>, pageSize: number): Post[] {
  if (fresh.length < pageSize) return fresh
  const ids = new Set(fresh.map(p => p.id))
  const oldest = fresh[fresh.length - 1].created_at
  return [...fresh, ...cached.filter(p => !ids.has(p.id) && p.created_at < oldest && stillVisible.has(p.id))]
}

/** The cached posts whose visibility has to be re-checked before showing them below a fresh page. */
export function olderThanPage(fresh: Post[], cached: Post[], pageSize: number): string[] {
  if (fresh.length < pageSize || !fresh.length) return []
  const ids = new Set(fresh.map(p => p.id)), oldest = fresh[fresh.length - 1].created_at
  return cached.filter(p => !ids.has(p.id) && p.created_at < oldest).map(p => p.id)
}

/** Puts a post the server just confirmed in its place (newest first), once. */
export function withConfirmed(list: Post[], confirmed?: Post | null): Post[] {
  if (!confirmed || list.some(p => p.id === confirmed.id)) return list
  const at = list.findIndex(p => p.created_at <= confirmed.created_at)
  return at < 0 ? [...list, confirmed] : [...list.slice(0, at), confirmed, ...list.slice(at)]
}

/** Appends a page, skipping anything already shown (a post can move between pages when new ones arrive). */
export const appendPage = (cur: Post[], page: Post[]) => [...cur, ...page.filter(n => !cur.some(c => c.id === n.id))]

/** Every stored file a page of posts will show first (cover image, gallery, author pictures), for one batched signing call. */
export const pagePaths = (posts: Post[]) => posts.flatMap(p => [p.media_path, p.profiles?.avatar_path, ...(p.post_media ?? []).map(m => m.path)])

/** How far ahead to start fetching the next page: less with data saver (chosen in Settings, or the browser's own setting / a slow connection). */
export const prefetchMargin = (): string => currentPolicy().pageMargin
