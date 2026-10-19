/**
 * Selection rules that make Home and Discover different products. Kept pure so they can be unit-tested;
 * visibility, blocks and privacy are still enforced by Row Level Security on every query.
 */

/** Caps keep the filter inside PostgREST URL limits (UUIDs are 36 chars each). */
export const HOME_MAX_AUTHORS = 200
export const HOME_MAX_COMMUNITIES = 100

/**
 * Home = people you have chosen (accepted friends + yourself) and communities you belong to.
 * Returned as a PostgREST `or` filter. Public posts from strangers are deliberately not part of it.
 */
export function homeFilter(uid: string, friends: string[], communities: string[]): string {
  const authors = [uid, ...friends.filter(f => f !== uid)].slice(0, HOME_MAX_AUTHORS)
  const parts = [`author.in.(${authors.join(',')})`]
  if (communities.length) parts.push(`community_id.in.(${communities.slice(0, HOME_MAX_COMMUNITIES).join(',')})`)
  return parts.join(',')
}

/** Why a post is on Home, shown under the author ("see why you're seeing this"). */
export function homeReason(p: { author: string; visibility: string; community_id: string | null }, uid: string, friends: Set<string>): string {
  if (p.author === uid) return 'Your post'
  if (p.community_id && p.visibility === 'community') return 'From a community you belong to'
  if (friends.has(p.author)) return 'From a friend'
  return 'From a community you belong to'
}

/** Interests two people or a person and a community have in common (case-insensitive, original casing kept). */
export function sharedInterests(mine: string[] | undefined, theirs: string[] | undefined): string[] {
  const set = new Set((mine ?? []).map(i => i.toLowerCase()))
  return (theirs ?? []).filter(i => set.has(i.toLowerCase()))
}

/** Orders by number of shared interests (desc), then by the original order (stable), so newest-first inputs stay newest-first within a tier. */
export function rankByInterest<T>(items: T[], mine: string[] | undefined, interestsOf: (t: T) => string[] | undefined): T[] {
  return items.map((t, i) => ({ t, i, n: sharedInterests(mine, interestsOf(t)).length }))
    .sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.t)
}
