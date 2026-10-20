import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { callFunction } from './functions'

/**
 * Client for the `maps` edge function (Google Places / Routes / Static Maps live server-side behind GOOGLE_MAPS_SERVER_KEY).
 * Everything degrades: no key, no function, or a failed call all end up as "unavailable" and callers show plain addresses instead.
 */
let status: Promise<boolean> | null = null
export const mapsConfigured = () => (status ??= callFunction<{ configured: boolean }>('maps', { op: 'status' }).then(r => Boolean(r.configured)).catch(() => false))
export const resetMapsStatus = () => { status = null }
export function useMapsConfigured() {
  const [ok, setOk] = useState<boolean | null>(null)
  useEffect(() => { let live = true; mapsConfigured().then(v => live && setOk(v)); return () => { live = false } }, [])
  return ok                                    // null = still checking
}

export interface Suggestion { place_id: string; text: string; main: string; secondary: string }
export interface PlaceDetails { name: string | null; address: string | null; lat: number | null; lng: number | null; city: string | null; country: string | null }
export interface RouteInfo { distance_m: number; duration_s: number; mode: string; polyline: string | null }
export type Mode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT'

export const searchPlaces = (q: string, near?: { lat: number; lng: number }) => callFunction<{ results: Suggestion[] }>('maps', { op: 'autocomplete', q, near }).then(r => r.results)
export const placeDetails = (place_id: string) => callFunction<PlaceDetails>('maps', { op: 'place', place_id })
export const routeBetween = (origin: { lat: number; lng: number }, dest: { lat: number; lng: number }, mode: Mode) => callFunction<RouteInfo>('maps', { op: 'route', origin, dest, mode })

/** Static preview as an object URL. The request carries the member's session; the Google key stays on the server. */
export async function staticMap(markers: { lat: number; lng: number }[], opts: { w?: number; h?: number; dark?: boolean } = {}): Promise<string | null> {
  const { data: s } = await supabase.auth.getSession()
  const token = s.session?.access_token
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined
  if (!token || !base) return null
  try {
    const r = await fetch(`${base}/functions/v1/maps`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string }, body: JSON.stringify({ op: 'static', markers, ...opts }) })
    if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/')) return null
    return URL.createObjectURL(await r.blob())
  } catch { return null }
}

export const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)
export const formatDuration = (s: number) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() }
