import { useEffect, useSyncExternalStore } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'

/**
 * Who is online, for friends only (migration 32). While the app is open and visible, a member announces themselves on
 * their own private Realtime channel `online:<id>`; the server lets only their accepted friends listen there. Friends'
 * dots come from listening to those friends' channels (a bounded number, the ones on screen).
 */
const PREF = 'vybe:show-active'
/** Per device: "Show when I'm active". On by default. */
export const showActive = () => { try { return localStorage.getItem(PREF) !== '0' } catch { return true } }
export const setShowActive = (on: boolean) => { try { localStorage.setItem(PREF, on ? '1' : '0') } catch { /* storage unavailable */ } window.dispatchEvent(new Event(PREF)) }

/** Announce this member while the tab is visible (and they allow it). Mounted once, in the app shell. */
export function useAnnouncePresence(uid: string | null) {
  useEffect(() => {
    if (!uid) return
    let ch: RealtimeChannel | null = null
    const on = () => {
      if (ch || !showActive() || document.visibilityState !== 'visible') return
      ch = supabase.channel(`online:${uid}`, { config: { private: true, presence: { key: uid } } })
      ch.subscribe(status => { if (status === 'SUBSCRIBED') void ch?.track({ at: Date.now() }) })
    }
    const off = () => { if (ch) { void supabase.removeChannel(ch); ch = null } }
    const sync = () => (document.visibilityState === 'visible' && showActive() ? on() : off())
    sync()
    document.addEventListener('visibilitychange', sync); window.addEventListener(PREF, sync)
    return () => { document.removeEventListener('visibilitychange', sync); window.removeEventListener(PREF, sync); off() }
  }, [uid])
}

/* ---------------------------------------------------------------- watching friends */
const online = new Set<string>()
const watching = new Map<string, { ch: RealtimeChannel; n: number }>()
let version = 0
const subs = new Set<() => void>()
const emit = () => { version++; subs.forEach(f => f()) }
const MAX_WATCH = 40

function watch(id: string) {
  const w = watching.get(id); if (w) { w.n++; return }
  if (watching.size >= MAX_WATCH) return
  const ch = supabase.channel(`online:${id}`, { config: { private: true } })
  ch.on('presence', { event: 'sync' }, () => {
    const here = Object.keys(ch.presenceState()).includes(id)
    if (here !== online.has(id)) { here ? online.add(id) : online.delete(id); emit() }
  }).subscribe()
  watching.set(id, { ch, n: 1 })
}
function unwatch(id: string) {
  const w = watching.get(id); if (!w) return
  if (--w.n > 0) return
  void supabase.removeChannel(w.ch); watching.delete(id)
  if (online.delete(id)) emit()
}

/** Online status for these people (friends; anyone else simply never shows as online). */
export function useOnline(ids: string[]): (id: string) => boolean {
  const key = ids.slice(0, MAX_WATCH).join(',')
  useEffect(() => {
    const list = key ? key.split(',') : []
    list.forEach(watch)
    return () => list.forEach(unwatch)
  }, [key])
  useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => version)
  return (id: string) => online.has(id)
}
