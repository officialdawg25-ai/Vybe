import { useSyncExternalStore } from 'react'

/**
 * Which file a video plays from: the original upload, or its smaller copy (at most 480p, lib/videoCopy) when the post has
 * one. Only real files are ever offered — a video without a copy has no quality choice.
 *   auto      the copy on Data saver or a low-end device (lib/dataMode), or for the rest of the visit once videos have
 *             stalled twice within a minute; otherwise the original
 *   original  always the original
 *   small     the copy whenever there is one
 * The choice is a per-device convenience kept in this browser. A copy this browser cannot play (or that failed once) is
 * never chosen again in this visit: playback falls back to the original.
 */
export type VideoQuality = 'auto' | 'original' | 'small'
const KEY = 'vybe:video-quality'
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

let choice: VideoQuality = (() => { try { const v = localStorage.getItem(KEY); return v === 'original' || v === 'small' ? v : 'auto' } catch { return 'auto' } })()
export const setVideoQuality = (q: VideoQuality) => { choice = q; try { if (q === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, q) } catch { /* this visit only */ } emit() }
export const useVideoQuality = () => useSyncExternalStore(subscribe, () => choice)
export const currentVideoQuality = () => choice

/* stalls: two within a minute switch Auto to the copy for the rest of the visit (no flapping back and forth) */
let stalls: number[] = []
let lowAfterStalls = false
export function noteStall(now = Date.now()) {
  if (lowAfterStalls) return
  stalls = [...stalls.filter(t => now - t < 60_000), now]
  if (stalls.length >= 2) { lowAfterStalls = true; emit() }
}
export const useStalledLow = () => useSyncExternalStore(subscribe, () => lowAfterStalls)

const broken = new Set<string>()
export const markCopyBroken = (path: string) => { if (!broken.has(path)) { broken.add(path); emit() } }
export const useBrokenVersion = () => useSyncExternalStore(subscribe, () => broken.size)

const playable = new Map<string, boolean>()
/** Whether this browser can play a copy, judged from its file type. */
export function canPlayCopy(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (playable.has(ext)) return playable.get(ext)!
  let ok = false
  try { ok = typeof document !== 'undefined' && document.createElement('video').canPlayType(ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : '') !== '' } catch { ok = false }
  playable.set(ext, ok)
  return ok
}

export interface PickContext { saver: boolean; lowEnd: boolean; stalledLow: boolean; canPlay: (path: string) => boolean; broken: (path: string) => boolean }
/** The path to play and whether it is the copy. Pure, so it is unit-tested. */
export function pickVideoPath(m: { path: string; type: string; display_path?: string | null }, q: VideoQuality, c: PickContext): { path: string; small: boolean; hasCopy: boolean } {
  const copy = m.type === 'video' && m.display_path && !c.broken(m.display_path) && c.canPlay(m.display_path) ? m.display_path : null
  if (!copy) return { path: m.path, small: false, hasCopy: false }
  const small = q === 'small' || (q === 'auto' && (c.saver || c.lowEnd || c.stalledLow))
  return { path: small ? copy : m.path, small, hasCopy: true }
}
export const pickContext = (p: { saver: boolean; lowEnd: boolean }, stalledLow: boolean): PickContext =>
  ({ saver: p.saver, lowEnd: p.lowEnd, stalledLow, canPlay: canPlayCopy, broken: x => broken.has(x) })
