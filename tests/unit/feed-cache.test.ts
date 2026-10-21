import { afterEach, describe, expect, it } from 'vitest'
import { appendPage, clearFeeds, olderThanPage, pagePaths, readFeed, reconcile, withConfirmed, writeFeed } from '../../src/lib/feedCache'
import type { Post } from '../../src/lib/types'

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 60_000).toISOString()
const post = (id: string, minute: number, extra: Partial<Post> = {}) => ({ id, created_at: at(minute), media_path: null, profiles: { id: 'u', username: 'u', display_name: 'U', avatar_path: null }, ...extra }) as unknown as Post
const ids = (l: Post[]) => l.map(p => p.id)

afterEach(clearFeeds)

describe('feed snapshots and reconciliation', () => {
  it('a short fresh page is everything there is: cached posts that vanished are not replayed', () => {
    const cached = [post('c', 3), post('b', 2), post('deleted', 1)]
    expect(ids(reconcile([post('d', 4), post('c', 3), post('b', 2)], cached, new Set(['deleted']), 15))).toEqual(['d', 'c', 'b'])
  })
  it('keeps older cached posts below a full fresh page only when the server says they are still visible', () => {
    const fresh = [post('f2', 20), post('f1', 19)]
    const cached = [post('f1', 19), post('o3', 5), post('gone', 4), post('o1', 3)]
    expect(olderThanPage(fresh, cached, 2)).toEqual(['o3', 'gone', 'o1'])
    expect(ids(reconcile(fresh, cached, new Set(['o3', 'o1']), 2))).toEqual(['f2', 'f1', 'o3', 'o1'])
    expect(ids(reconcile(fresh, cached, new Set(), 2))).toEqual(['f2', 'f1'])               // the check failed: show only what is fresh
  })
  it('places a just-confirmed post once, in time order', () => {
    const list = [post('b', 5), post('a', 1)]
    expect(ids(withConfirmed(list, post('new', 9)))).toEqual(['new', 'b', 'a'])
    expect(ids(withConfirmed([post('new', 9), ...list], post('new', 9)))).toEqual(['new', 'b', 'a'])
    expect(withConfirmed(list, null)).toBe(list)
  })
  it('appending a page never duplicates a post that moved between pages', () => {
    expect(ids(appendPage([post('c', 3), post('b', 2)], [post('b', 2), post('a', 1)]))).toEqual(['c', 'b', 'a'])
  })
  it('signs the cover, the gallery and the author picture of a page in one batch', () => {
    const p = post('x', 1, { media_path: 'u/1.jpg', profiles: { id: 'u', username: 'u', display_name: 'U', avatar_path: 'u/av.webp' } as Post['profiles'] })
    p.post_media = [{ path: 'u/1.jpg', type: 'image', sort: 0 }, { path: 'u/2.jpg', type: 'image', sort: 1 }]
    expect(pagePaths([p])).toEqual(['u/1.jpg', 'u/av.webp', 'u/1.jpg', 'u/2.jpg'])
  })
  it('snapshots are per key and capped', () => {
    writeFeed('home:a:all', { posts: Array.from({ length: 200 }, (_, i) => post(`p${i}`, 1000 - i)), done: true, scrollY: 420 })
    expect(readFeed('home:a:all')?.posts).toHaveLength(120)
    expect(readFeed('home:a:all')?.done).toBe(false)                                           // the rest is fetched again when scrolled to
    expect(readFeed('home:b:all')).toBeUndefined()
    writeFeed(undefined, { posts: [], done: true, scrollY: 0 })
    clearFeeds(); expect(readFeed('home:a:all')).toBeUndefined()
  })
})
