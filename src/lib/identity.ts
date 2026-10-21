import { useSyncExternalStore } from 'react'
import { supabase } from './supabase'

/**
 * One profile picture everywhere.
 *
 * `profiles.avatar_path` is the only source of truth, but every screen reads it through its own query (post authors, comments,
 * inbox, memory rail…), so a picture changed in this session — or in another tab, or by another member — left those copies
 * pointing at a file that no longer exists (the old one is deleted on replace), and they fell back to initials.
 *
 * This store remembers the newest avatar path we have learned for a member and which paths are known to be replaced:
 *  - a replace in this tab updates it at once (and tells other tabs over a BroadcastChannel);
 *  - a picture that fails to load asks the database for that member's current path (batched, throttled, under RLS);
 *  - `resolveAvatar` swaps a stale or missing path for the current one. A path nobody has replaced is always shown as given,
 *    so data that is newer than what we learned is never overridden.
 * Media paths start with the owner's user id (storage policies key off that folder), which is how a stale path finds its member.
 */

const latest = new Map<string, string | null>()     // member id → newest avatar path we know of
const superseded = new Set<string>()               // avatar paths known to have been replaced
const listeners = new Set<() => void>()
let version = 0
const bump = () => { version++; listeners.forEach(f => f()) }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The member a stored media path belongs to (its first folder), or null. */
export const avatarOwner = (path?: string | null): string | null => {
  const head = path?.split('/')[0]
  return head && UUID.test(head) ? head.toLowerCase() : null
}

type Msg = { uid: string; path: string | null; old?: string | null }
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel('vybe-identity') : null

function apply({ uid, path, old }: Msg) {
  const prev = latest.get(uid)
  const changed = !latest.has(uid) || prev !== path || Boolean(old && !superseded.has(old))
  if (prev && prev !== path) superseded.add(prev)
  if (old && old !== path) superseded.add(old)
  if (path) superseded.delete(path)
  latest.set(uid, path)
  if (changed) bump()
}
channel?.addEventListener('message', e => { const m = e.data as Msg; if (m && typeof m.uid === 'string') apply(m) })

/** Record a member's current avatar (e.g. right after this member changed it). Other tabs hear about it too. */
export function learnAvatar(uid: string, path: string | null, old?: string | null) {
  const m = { uid: uid.toLowerCase(), path, old }
  apply(m)
  try { channel?.postMessage(m) } catch { /* closed channel */ }
}

/**
 * The path to show. Given paths win unless we know they were replaced; a missing path (stale data from before a first upload)
 * falls back to what we learned for that member when the caller tells us who it is.
 */
export function resolveAvatar(path?: string | null, uid?: string | null): string | null {
  if (path && !superseded.has(path)) return path
  const owner = uid?.toLowerCase() ?? avatarOwner(path)
  if (owner && latest.has(owner)) return latest.get(owner) ?? null
  return path ?? null
}

/* ---------------------------------------------------------------- self-healing: ask the database when a picture fails */
type Fetch = (ids: string[]) => Promise<{ id: string; avatar_path: string | null }[]>
const fetchProfiles: Fetch = async ids => {
  const { data, error } = await supabase.from('profiles').select('id,avatar_path').in('id', ids)
  if (error) throw error
  return (data ?? []) as { id: string; avatar_path: string | null }[]
}
let fetcher: Fetch = fetchProfiles
/** Tests swap the database read. */
export const setAvatarFetcher = (f: Fetch | null) => { fetcher = f ?? fetchProfiles }

const HEAL_EVERY_MS = 60_000
const lastHeal = new Map<string, number>()
let queue = new Map<string, Set<string>>()        // member id → failing paths
let timer: ReturnType<typeof setTimeout> | null = null

async function flush() {
  timer = null
  const batch = queue; queue = new Map()
  if (!batch.size) return
  try {
    const rows = await fetcher([...batch.keys()])
    for (const r of rows) {
      const id = r.id.toLowerCase()
      for (const failed of batch.get(id) ?? []) if (failed !== r.avatar_path) superseded.add(failed)
      apply({ uid: id, path: r.avatar_path })
    }
    bump()
  } catch { /* offline: the next failure asks again after the throttle */ }
}

/**
 * A picture failed to load or sign: look up that member's current avatar (one request for every failure in the same moment,
 * at most once a minute per member).
 */
export function healAvatar(path?: string | null, uid?: string | null) {
  const owner = uid?.toLowerCase() ?? avatarOwner(path)
  if (!owner) return
  const now = Date.now()
  if ((lastHeal.get(owner) ?? 0) > now - HEAL_EVERY_MS) return
  lastHeal.set(owner, now)
  const set = queue.get(owner) ?? new Set<string>()
  if (path) set.add(path)
  queue.set(owner, set)
  timer ??= setTimeout(() => void flush(), 30)
}
/** Resolves once queued lookups have finished (tests). */
export const flushAvatarLookups = () => { if (timer) { clearTimeout(timer); return flush() } return Promise.resolve() }
/** Forget everything (sign-out, tests). */
export function resetIdentity() { latest.clear(); superseded.clear(); lastHeal.clear(); queue = new Map(); bump() }

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }
/** Re-renders the caller whenever an avatar we know about changes. */
export const useIdentityVersion = () => useSyncExternalStore(subscribe, () => version, () => version)
