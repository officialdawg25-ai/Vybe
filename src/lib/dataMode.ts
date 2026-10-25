import { useEffect, useState } from 'react'

/**
 * How much VYBE downloads and decodes on this device. A per-device choice (phones and laptops differ), so it lives in this
 * browser's storage, not on the account.
 *   auto    adapt to what the browser reports (data saver switched on, a 2G/3G connection, a low-memory device)
 *   high    prefer the best picture: photos as uploaded, larger video, 1080p live when the device can capture it
 *   saver   save mobile data: feed videos start on tap, smaller live video, feed pages fetched later
 *   device  go easy on an older phone: one video decoding at a time, lighter live video, less animation
 * Browser signals are hints, not facts: they are read each time and never stored or sent anywhere.
 */
export type DataMode = 'auto' | 'high' | 'saver' | 'device'
const KEY = 'vybe:data-mode'
const MODES: DataMode[] = ['auto', 'high', 'saver', 'device']
const subs = new Set<() => void>()

export function getDataMode(): DataMode {
  try { const v = localStorage.getItem(KEY) as DataMode | null; return v && MODES.includes(v) ? v : 'auto' } catch { return 'auto' }
}
export function setDataMode(m: DataMode) {
  try { if (m === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, m) } catch { /* private mode: this visit only */ }
  current = m; subs.forEach(f => f())
}
let current: DataMode | null = null
export function useDataMode(): DataMode {
  const [m, set] = useState<DataMode>(() => current ?? getDataMode())
  useEffect(() => { const f = () => set(current ?? getDataMode()); subs.add(f); return () => { subs.delete(f) } }, [])
  return m
}

export interface Conditions { saveData: boolean; effectiveType: string; cores: number; memoryGb: number | null; reducedMotion: boolean }
export function readConditions(): Conditions {
  const n = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number }
  return {
    saveData: Boolean(n.connection?.saveData),
    effectiveType: n.connection?.effectiveType ?? '',
    cores: n.hardwareConcurrency ?? 8,
    memoryGb: typeof n.deviceMemory === 'number' ? n.deviceMemory : null,
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  }
}

export interface Policy {
  /** Prepare the next reel (its first bytes only) before it is on screen. Measured: costs almost no data on its own (the
   *  playing reel's buffering dominates) and saves ~0.4 s per swipe, so only constrained devices skip it. */
  prefetchNextVideo: boolean
  /** Feed videos start by themselves when on screen (muted); otherwise on tap. */
  autoplayFeedVideo: boolean
  /** How early the next page of a feed is requested. */
  pageMargin: string
  /** Data saver in effect (explicitly or from the browser's own setting / a slow connection). */
  saver: boolean
  /** Constrained device in effect. */
  lowEnd: boolean
  /** Feeds show photos as uploaded instead of their phone-sized display copy (High quality only). */
  originalPhotos: boolean
}
/** The behaviour a mode resolves to on this device right now. Pure, so it is unit-tested. */
export function resolvePolicy(mode: DataMode, c: Conditions): Policy {
  const slow = /(^|-)2g$/.test(c.effectiveType) || c.effectiveType === '3g'
  const saver = mode === 'saver' || (mode === 'auto' && (c.saveData || slow))
  const lowEnd = mode === 'device' || (mode === 'auto' && ((c.memoryGb != null && c.memoryGb <= 2) || c.cores <= 2))
  return {
    prefetchNextVideo: !lowEnd,
    autoplayFeedVideo: !saver,
    pageMargin: saver ? '300px 0px' : '1400px 0px',
    saver, lowEnd,
    originalPhotos: mode === 'high',
  }
}
export const currentPolicy = () => resolvePolicy(current ?? getDataMode(), readConditions())
export function usePolicy(): Policy {
  const m = useDataMode()
  return resolvePolicy(m, readConditions())
}
