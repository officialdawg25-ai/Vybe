import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { callFunction } from './functions'

/**
 * Client for the `maps` edge function (Google Places / Routes / Static Maps live server-side behind GOOGLE_MAPS_SERVER_KEY).
 * Everything degrades: no key, no function, or a failed call all end up as "unavailable" and callers show plain addresses instead.
 */
let gmaps: Promise<GMaps> | null = null
let status: Promise<{ configured: boolean; browserKey: string | null }> | null = null
const loadStatus = () => (status ??= callFunction<{ configured: boolean; browser_key?: string | null }>('maps', { op: 'status' })
  .then(r => ({ configured: Boolean(r.configured), browserKey: typeof r.browser_key === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(r.browser_key) ? r.browser_key : null }))
  .catch(() => ({ configured: false, browserKey: null })))
export const mapsConfigured = () => loadStatus().then(s => s.configured)
/** The browser key for the interactive map (Google Maps JavaScript API). It is a public key by design, restricted by
 *  Google to this site's address; it is served at run time so it can be added or rotated without a new build. */
export const mapsBrowserKey = () => loadStatus().then(s => s.browserKey)
export const resetMapsStatus = () => { status = null; gmaps = null }

/* Minimal typing for the parts of the Google Maps JavaScript API the map screen uses. */
export interface GLatLng { lat(): number; lng(): number }
export interface GMap { fitBounds(b: unknown, pad?: number): void; panTo(p: { lat: number; lng: number }): void; setZoom(z: number): void; getZoom(): number; setCenter(p: { lat: number; lng: number }): void }
export interface GMarker { setMap(m: GMap | null): void; setIcon(i: unknown): void; setZIndex(z: number): void; addListener(e: string, f: () => void): void }
export interface GMaps {
  Map: new (el: HTMLElement, o: Record<string, unknown>) => GMap
  Marker: new (o: Record<string, unknown>) => GMarker
  LatLngBounds: new () => { extend(p: { lat: number; lng: number }): void }
  Size: new (w: number, h: number) => unknown
  Point: new (x: number, y: number) => unknown
}
/** Loads Google's script once, only when a map is opened (nothing is fetched from Google otherwise). */
export function loadGoogleMaps(key: string): Promise<GMaps> {
  const w = window as unknown as { google?: { maps?: GMaps }; __vybeMaps?: () => void }
  if (w.google?.maps?.Map) return Promise.resolve(w.google.maps)
  return (gmaps ??= new Promise<GMaps>((resolve, reject) => {
    const timer = window.setTimeout(() => { gmaps = null; reject(new Error('Google Maps took too long to load.')) }, 15000)
    w.__vybeMaps = () => { window.clearTimeout(timer); w.google?.maps ? resolve(w.google.maps) : reject(new Error('Google Maps did not start.')) }
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__vybeMaps`
    s.async = true
    s.onerror = () => { window.clearTimeout(timer); gmaps = null; reject(new Error('Google Maps could not load.')) }
    document.head.appendChild(s)
  }))
}
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
