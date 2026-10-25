/**
 * Selection rules for Home (what your world is saying) and Discover (what is happening around a place). Kept pure so they can be unit-tested;
 * visibility, blocks and privacy are still enforced by Row Level Security on every query.
 */

/** Authors for the Friends tab: yourself plus accepted friends, capped to stay inside PostgREST URL limits. */
export const FRIENDS_MAX = 200
export const friendsAndMe = (uid: string, friends: string[]) => [uid, ...friends.filter(f => f !== uid)].slice(0, FRIENDS_MAX)

/**
 * Home shows everything the viewer is allowed to see (Row Level Security does the filtering: public posts, friends' posts,
 * communities they belong to, organization pages, shared plans) newest first. This only explains why a post is there.
 */
export function homeReason(p: { author: string; visibility: string; community_id: string | null; organization_id?: string | null }, uid: string, friends: Set<string>): string {
  if (p.author === uid) return 'Your post'
  if (p.organization_id) return 'From a page'
  if (friends.has(p.author)) return 'From a friend'
  if (p.visibility === 'community') return 'From a community you belong to'
  return 'Public post'
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

/** A fresh random order per visit, so Home does not show the same rail in the same place every time. */
export function shuffled<T>(list: T[], rand = Math.random): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

/** After which post (0-based) the n-th rail goes: after the 3rd post, then every 5 posts. */
export const railSlot = (index: number) => (index >= 2 && (index - 2) % 5 === 0 ? (index - 2) / 5 : -1)
