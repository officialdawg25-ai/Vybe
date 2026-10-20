/** Built-in city list (approximate city-centre coordinates) so location never depends on a third-party geocoder. */
export interface City { name: string; country: string; lat: number; lng: number }

export const CITIES: City[] = [
  // South Africa
  { name: 'Johannesburg', country: 'South Africa', lat: -26.2041, lng: 28.0473 }, { name: 'Sandton', country: 'South Africa', lat: -26.1076, lng: 28.0567 },
  { name: 'Soweto', country: 'South Africa', lat: -26.2678, lng: 27.8585 }, { name: 'Pretoria', country: 'South Africa', lat: -25.7479, lng: 28.2293 },
  { name: 'Centurion', country: 'South Africa', lat: -25.8603, lng: 28.1894 }, { name: 'Midrand', country: 'South Africa', lat: -25.9992, lng: 28.1263 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.9249, lng: 18.4241 }, { name: 'Stellenbosch', country: 'South Africa', lat: -33.9321, lng: 18.8602 },
  { name: 'Durban', country: 'South Africa', lat: -29.8587, lng: 31.0218 }, { name: 'Pietermaritzburg', country: 'South Africa', lat: -29.6006, lng: 30.3794 },
  { name: 'Gqeberha (Port Elizabeth)', country: 'South Africa', lat: -33.9608, lng: 25.6022 }, { name: 'East London', country: 'South Africa', lat: -33.0153, lng: 27.9116 },
  { name: 'Bloemfontein', country: 'South Africa', lat: -29.0852, lng: 26.1596 }, { name: 'Polokwane', country: 'South Africa', lat: -23.9045, lng: 29.4689 },
  { name: 'Thohoyandou', country: 'South Africa', lat: -22.9453, lng: 30.4849 }, { name: 'Mbombela (Nelspruit)', country: 'South Africa', lat: -25.4753, lng: 30.9694 },
  { name: 'Rustenburg', country: 'South Africa', lat: -25.6676, lng: 27.2421 }, { name: 'Mahikeng', country: 'South Africa', lat: -25.8652, lng: 25.6442 },
  { name: 'Kimberley', country: 'South Africa', lat: -28.7282, lng: 24.7499 }, { name: 'George', country: 'South Africa', lat: -33.963, lng: 22.4617 },
  { name: 'Richards Bay', country: 'South Africa', lat: -28.7807, lng: 32.0383 }, { name: 'Ekurhuleni (East Rand)', country: 'South Africa', lat: -26.1494, lng: 28.3322 },
  // Rest of Africa
  { name: 'Gaborone', country: 'Botswana', lat: -24.6282, lng: 25.9231 }, { name: 'Windhoek', country: 'Namibia', lat: -22.5609, lng: 17.0658 },
  { name: 'Maputo', country: 'Mozambique', lat: -25.9692, lng: 32.5732 }, { name: 'Harare', country: 'Zimbabwe', lat: -17.8252, lng: 31.0335 },
  { name: 'Lusaka', country: 'Zambia', lat: -15.3875, lng: 28.3228 }, { name: 'Maseru', country: 'Lesotho', lat: -29.3151, lng: 27.4869 },
  { name: 'Mbabane', country: 'Eswatini', lat: -26.3054, lng: 31.1367 }, { name: 'Nairobi', country: 'Kenya', lat: -1.2921, lng: 36.8219 },
  { name: 'Kampala', country: 'Uganda', lat: 0.3476, lng: 32.5825 }, { name: 'Dar es Salaam', country: 'Tanzania', lat: -6.7924, lng: 39.2083 },
  { name: 'Kigali', country: 'Rwanda', lat: -1.9441, lng: 30.0619 }, { name: 'Lagos', country: 'Nigeria', lat: 6.5244, lng: 3.3792 },
  { name: 'Abuja', country: 'Nigeria', lat: 9.0765, lng: 7.3986 }, { name: 'Accra', country: 'Ghana', lat: 5.6037, lng: -0.187 },
  { name: 'Cairo', country: 'Egypt', lat: 30.0444, lng: 31.2357 }, { name: 'Casablanca', country: 'Morocco', lat: 33.5731, lng: -7.5898 },
  // World
  { name: 'London', country: 'United Kingdom', lat: 51.5072, lng: -0.1276 }, { name: 'Manchester', country: 'United Kingdom', lat: 53.4808, lng: -2.2426 },
  { name: 'New York', country: 'United States', lat: 40.7128, lng: -74.006 }, { name: 'Los Angeles', country: 'United States', lat: 34.0522, lng: -118.2437 },
  { name: 'Miami', country: 'United States', lat: 25.7617, lng: -80.1918 }, { name: 'Atlanta', country: 'United States', lat: 33.749, lng: -84.388 },
  { name: 'Toronto', country: 'Canada', lat: 43.6532, lng: -79.3832 }, { name: 'Dubai', country: 'United Arab Emirates', lat: 25.2048, lng: 55.2708 },
  { name: 'Paris', country: 'France', lat: 48.8566, lng: 2.3522 }, { name: 'Berlin', country: 'Germany', lat: 52.52, lng: 13.405 },
  { name: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lng: 4.9041 }, { name: 'Lisbon', country: 'Portugal', lat: 38.7223, lng: -9.1393 },
  { name: 'Sydney', country: 'Australia', lat: -33.8688, lng: 151.2093 }, { name: 'Mumbai', country: 'India', lat: 19.076, lng: 72.8777 },
  { name: 'Singapore', country: 'Singapore', lat: 1.3521, lng: 103.8198 }, { name: 'São Paulo', country: 'Brazil', lat: -23.5505, lng: -46.6333 },
]

export const DEFAULT_CITY = CITIES[0]

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
export function searchCities(q: string, limit = 8): City[] {
  const n = norm(q.trim())
  if (!n) return CITIES.slice(0, limit)
  return CITIES.filter(c => norm(c.name).includes(n) || norm(c.country).includes(n)).sort((a, b) => Number(norm(b.name).startsWith(n)) - Number(norm(a.name).startsWith(n))).slice(0, limit)
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const nearestCity = (lat: number, lng: number): City => CITIES.reduce((best, c) => (distanceKm({ lat, lng }, c) < distanceKm({ lat, lng }, best) ? c : best), CITIES[0])

export function directionsUrl(dest: { lat?: number | null; lng?: number | null; venue?: string | null; address?: string | null; city?: string | null }, provider: 'google' | 'apple' = 'google'): string | null {
  const q = dest.lat != null && dest.lng != null ? `${dest.lat},${dest.lng}` : [dest.venue, dest.address, dest.city].filter(Boolean).join(', ')
  if (!q) return null
  return provider === 'apple' ? `https://maps.apple.com/?daddr=${encodeURIComponent(q)}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`
}
