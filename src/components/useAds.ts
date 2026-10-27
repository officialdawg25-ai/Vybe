import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { fetchPosts } from '../lib/posts'
import { boostFeed, type AdInfo } from '../lib/sponsor'
import type { Post } from '../lib/types'

export interface AdItem { ad: AdInfo; post: Post }

/**
 * This member's boosted posts for a placement, loaded once per visit. The database decides who sees what (audience, blocks,
 * hides, a daily frequency cap); the posts themselves are read normally, under the same visibility rules as any post.
 * Fails soft: any problem means "no ads", never a broken feed.
 */
export function useAds(placement?: 'home' | 'discover') {
  const { uid } = useAuth()
  return useAsync(async (): Promise<AdItem[]> => {
    if (!placement || !uid) return []
    try {
      const rows = await boostFeed(placement, 3)
      if (!rows.length) return []
      const posts = await fetchPosts({ uid, ids: rows.map(r => r.post_id) })
      return rows.flatMap(ad => { const post = posts.find(p => p.id === ad.post_id); return post ? [{ ad, post }] : [] })
    } catch { return [] }
  }, [placement, uid])
}
