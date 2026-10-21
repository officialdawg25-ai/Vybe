import { useSyncExternalStore } from 'react'

/**
 * Latest known name/photo per account. Rows such as posts and comments carry a copy of the author's profile from when
 * they were fetched; anything published here (your own profile on every load or edit) overrides that copy, so a new
 * name or photo shows everywhere at once without refetching the feed. Other people's changes arrive with the next fetch.
 */
type Identity = { display_name?: string; username?: string; avatar_path?: string | null }
const known = new Map<string, Identity>()
const subs = new Set<() => void>()
let version = 0

export function publishProfile(p: { id: string } & Identity) {
  const cur = known.get(p.id)
  if (cur && cur.display_name === p.display_name && cur.username === p.username && cur.avatar_path === p.avatar_path) return
  known.set(p.id, { display_name: p.display_name, username: p.username, avatar_path: p.avatar_path })
  version++
  subs.forEach(f => f())
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

/** Returns a function that overlays the freshest known identity on a profile copy. */
export function useLiveProfiles() {
  useSyncExternalStore(subscribe, () => version, () => version)
  return <T extends { id: string }>(p: T): T => {
    const k = known.get(p.id)
    return k ? { ...p, ...Object.fromEntries(Object.entries(k).filter(([, v]) => v !== undefined)) } : p
  }
}
