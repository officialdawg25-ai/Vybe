import { useEffect, useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { setFollow } from './discover'

/**
 * Who I follow (people), loaded once and shared by every post card and profile so a Follow button never needs its own request.
 * Optimistic updates roll back if the write fails.
 */
let set = new Set<string>()
let loadedFor: string | null = null
let loading = false
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
let version = 0
const bump = () => { version++; emit() }

async function load(uid: string) {
  if (loading || loadedFor === uid) return
  loading = true
  const { data, error } = await supabase.from('follows').select('target_id').eq('follower', uid).eq('target_type', 'profile').limit(5000)
  loading = false
  loadedFor = uid
  if (!error) { set = new Set((data ?? []).map(r => r.target_id as string)); bump() }
}

export function useFollowing(uid: string | null) {
  useEffect(() => { if (uid) void load(uid) }, [uid])
  useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => version)
  return {
    has: (id: string) => set.has(id),
    ready: loadedFor === uid,
    async toggle(id: string, on: boolean) {
      if (!uid) return
      on ? set.add(id) : set.delete(id); bump()
      try { await setFollow('profile', id, uid, on) } catch (e) { on ? set.delete(id) : set.add(id); bump(); throw e }
    },
  }
}
export const resetFollowStore = () => { set = new Set(); loadedFor = null; bump() }
