import { useCallback, useEffect, useState } from 'react'
import { CITIES, DEFAULT_CITY, nearestCity, type City } from './cities'

export interface Place { name: string; country: string; lat: number; lng: number; precise?: boolean }
const KEY = 'vybe:place'

export const readPlace = (): Place | null => {
  try { const p = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return p && typeof p.lat === 'number' && typeof p.lng === 'number' && typeof p.name === 'string' ? p : null } catch { return null }
}
const savePlace = (p: Place) => { try { localStorage.setItem(KEY, JSON.stringify(p)) } catch { /* storage unavailable */ } window.dispatchEvent(new Event('vybe:place')) }

/** The place Discover explores. Falls back to the profile location, then Johannesburg. Shared across tabs and components. */
export function usePlace(profile?: { location?: string | null; lat?: number | null; lng?: number | null; country?: string | null } | null) {
  const fromProfile = (): Place | null => {
    if (profile?.lat != null && profile?.lng != null) { const c = nearestCity(profile.lat, profile.lng); return { name: profile.location || c.name, country: profile.country || c.country, lat: profile.lat, lng: profile.lng } }
    const m = CITIES.find(c => profile?.location && c.name.toLowerCase().startsWith(profile.location.split(',')[0].trim().toLowerCase()))
    return m ?? null
  }
  const [place, setPlaceState] = useState<Place>(() => readPlace() ?? fromProfile() ?? DEFAULT_CITY)
  useEffect(() => {
    const sync = () => setPlaceState(readPlace() ?? fromProfile() ?? DEFAULT_CITY)
    window.addEventListener('vybe:place', sync); window.addEventListener('storage', sync)
    if (!readPlace()) sync()                                   // profile arrived after first render
    return () => { window.removeEventListener('vybe:place', sync); window.removeEventListener('storage', sync) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.lat, profile?.lng, profile?.location])
  const setPlace = useCallback((p: Place | City) => { savePlace(p); setPlaceState(p) }, [])
  return [place, setPlace] as const
}

/** Asks the browser for a position once, on request only. Resolves to the nearest listed city plus the exact point. */
export function locateMe(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device cannot share its location.'))
    navigator.geolocation.getCurrentPosition(
      pos => { const c = nearestCity(pos.coords.latitude, pos.coords.longitude); resolve({ name: `Near ${c.name}`, country: c.country, lat: +pos.coords.latitude.toFixed(3), lng: +pos.coords.longitude.toFixed(3), precise: true }) },
      err => reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location permission is blocked. Pick a city instead.' : 'Could not get your location. Pick a city instead.')),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 10 * 60_000 })
  })
}
