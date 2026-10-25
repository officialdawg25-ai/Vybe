import { asUser, CORS, dbError, json, preflight, whoami, type Deps } from '../http.ts'

/**
 * Google Maps proxy. The server key (GOOGLE_MAPS_SERVER_KEY) never leaves this function: the browser asks for an operation, we
 * authenticate the member, rate-limit them in Postgres (maps_gate, run as the member), validate every parameter, call Google,
 * and return only the fields the UI needs. No key => 503 'maps_unavailable' and the app falls back to plain addresses.
 *
 * Ops: status (also returns the public browser key, if set) | autocomplete (Places API New) | place (Places API New details) | route (Routes API) | static (Maps Static API)
 */
type Op = 'status' | 'autocomplete' | 'place' | 'route' | 'static'
const OPS = new Set<Op>(['status', 'autocomplete', 'place', 'route', 'static'])
const MODES = new Set(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT'])
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null)
const point = (v: unknown) => {
  const p = v as { lat?: unknown; lng?: unknown } | null
  const lat = num(p?.lat, -90, 90), lng = num(p?.lng, -180, 180)
  return lat == null || lng == null ? null : { lat, lng }
}
const unavailable = () => json({ error: 'maps_unavailable', message: 'Maps are not switched on yet.' }, 503)
const upstreamFailed = (status: number) => json({ error: status === 403 || status === 401 ? 'maps_denied' : 'maps_error', message: 'The maps service could not answer right now.' }, 502)

export async function handleMaps(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in to use maps.' }, 401)
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = body.op as Op
  if (!OPS.has(op)) return json({ error: 'Unknown operation.' }, 400)
  const key = deps.env.GOOGLE_MAPS_SERVER_KEY
  // The browser key (GOOGLE_MAPS_BROWSER_KEY) is public by design: Google restricts it to this site's address and to the
  // Maps JavaScript API. It is handed out here so the interactive map can be switched on without rebuilding the site.
  if (op === 'status') return json({ configured: Boolean(key), browser_key: deps.env.GOOGLE_MAPS_BROWSER_KEY || null })
  if (!key) return unavailable()

  const gate = await asUser(deps, me.token).rpc('maps_gate', { p_op: op })
  if (!gate.ok) return json({ error: await dbError(gate, 'Too many map requests.') }, gate.status === 401 ? 401 : 429)

  try {
    if (op === 'autocomplete') {
      const q = typeof body.q === 'string' ? body.q.trim() : ''
      if (q.length < 2 || q.length > 80) return json({ error: 'Type at least 2 characters.' }, 400)
      const bias = point(body.near)
      const r = await deps.fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ input: q, ...(bias ? { locationBias: { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 50000 } } } : {}) }),
      })
      if (!r.ok) return upstreamFailed(r.status)
      const d = (await r.json()) as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }[] }
      const results = (d.suggestions ?? []).flatMap(s => {
        const p = s.placePrediction
        return p?.placeId && p.text?.text ? [{ place_id: p.placeId, text: p.text.text, main: p.structuredFormat?.mainText?.text ?? p.text.text, secondary: p.structuredFormat?.secondaryText?.text ?? '' }] : []
      }).slice(0, 6)
      return json({ results })
    }

    if (op === 'place') {
      const id = body.place_id
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(id)) return json({ error: 'Invalid place.' }, 400)
      const r = await deps.fetch(`https://places.googleapis.com/v1/places/${id}`, { headers: { 'x-goog-api-key': key, 'x-goog-fieldmask': 'id,displayName,formattedAddress,location,addressComponents' } })
      if (!r.ok) return upstreamFailed(r.status)
      const d = (await r.json()) as { displayName?: { text?: string }; formattedAddress?: string; location?: { latitude?: number; longitude?: number }; addressComponents?: { longText?: string; types?: string[] }[] }
      const comp = (t: string) => d.addressComponents?.find(c => c.types?.includes(t))?.longText ?? null
      const lat = num(d.location?.latitude, -90, 90), lng = num(d.location?.longitude, -180, 180)
      return json({ name: d.displayName?.text ?? null, address: d.formattedAddress ?? null, lat, lng, city: comp('locality') ?? comp('sublocality') ?? comp('administrative_area_level_2'), country: comp('country') })
    }

    if (op === 'route') {
      const o = point(body.origin), dest = point(body.dest)
      const mode = typeof body.mode === 'string' && MODES.has(body.mode) ? body.mode : 'DRIVE'
      if (!o || !dest) return json({ error: 'Choose a start point and a destination.' }, 400)
      const ll = (p: { lat: number; lng: number }) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } })
      const r = await deps.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline' },
        body: JSON.stringify({ origin: ll(o), destination: ll(dest), travelMode: mode, ...(mode === 'DRIVE' ? { routingPreference: 'TRAFFIC_AWARE' } : {}) }),
      })
      if (!r.ok) return upstreamFailed(r.status)
      const d = (await r.json()) as { routes?: { duration?: string; distanceMeters?: number; polyline?: { encodedPolyline?: string } }[] }
      const route = d.routes?.[0]
      if (!route || typeof route.distanceMeters !== 'number') return json({ error: 'no_route', message: 'No route found for that mode of travel.' }, 404)
      return json({ distance_m: route.distanceMeters, duration_s: Number.parseInt(route.duration ?? '0', 10) || 0, mode, polyline: route.polyline?.encodedPolyline ?? null })
    }

    // static map: a preview image, returned as bytes (the key is added here, never in the URL the browser sees)
    const markers = Array.isArray(body.markers) ? body.markers.slice(0, 10).map(point).filter((p): p is { lat: number; lng: number } => p !== null) : []
    if (!markers.length) return json({ error: 'Nothing to show on the map.' }, 400)
    const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d)
    const w = clamp(body.w, 100, 640, 600), h = clamp(body.h, 100, 400, 300)
    const dark = body.dark === true
    const qs = new URLSearchParams({ size: `${w}x${h}`, scale: '2', maptype: 'roadmap', key })
    if (markers.length === 1) qs.set('zoom', '15')
    markers.forEach((m, i) => qs.append('markers', `color:0x6a4cff|label:${markers.length > 1 ? String.fromCharCode(65 + i) : ''}|${m.lat},${m.lng}`))
    if (dark) for (const s of ['element:geometry|color:0x242435', 'element:labels.text.fill|color:0x9a9ab0', 'feature:water|color:0x14141f']) qs.append('style', s)
    const r = await deps.fetch(`https://maps.googleapis.com/maps/api/staticmap?${qs}`)
    if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/')) return upstreamFailed(r.ok ? 403 : r.status)
    return new Response(await r.arrayBuffer(), { status: 200, headers: { 'content-type': r.headers.get('content-type')!, 'cache-control': 'private, max-age=86400', ...CORS } })
  } catch {
    return json({ error: 'maps_error', message: 'The maps service could not answer right now.' }, 502)
  }
}
