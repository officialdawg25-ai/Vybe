import { describe, expect, it } from 'vitest'
import { handleMaps } from '../../supabase/functions/_shared/handlers/maps.ts'
import type { Deps, Env } from '../../supabase/functions/_shared/http.ts'

const ENV: Env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon', GOOGLE_MAPS_SERVER_KEY: 'AIza-secret-key' }
interface W { gate?: { ok: boolean; status?: number }; google?: { status: number; body: unknown; image?: boolean }; noUser?: boolean }
function fake(w: W = {}, env: Env = ENV) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = []
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, body: typeof init.body === 'string' ? init.body : '', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) })
    if (url.endsWith('/auth/v1/user')) return w.noUser ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ id: 'u1', email: 'a@b.co', user_metadata: {} }))
    if (url.endsWith('/rpc/maps_gate')) return w.gate && !w.gate.ok ? new Response(JSON.stringify({ message: 'Too many map requests. Please wait a moment.' }), { status: w.gate.status ?? 400 }) : new Response('null')
    if (w.google?.image) return new Response(new Uint8Array([137, 80, 78, 71]), { status: w.google.status, headers: { 'content-type': 'image/png' } })
    return new Response(JSON.stringify(w.google?.body ?? {}), { status: w.google?.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, deps: { env, fetch: f } as Deps }
}
const req = (body: unknown, token = 'tok') => new Request('https://fn/maps', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
const googleCalls = <T extends { url: string }>(c: T[]) => c.filter(x => /googleapis\.com/.test(x.url))

describe('maps edge function', () => {
  it('needs a signed-in member and a known operation', async () => {
    expect((await handleMaps(req({ op: 'status' }, ''), fake().deps)).status).toBe(401)
    expect((await handleMaps(req({ op: 'status' }), fake({ noUser: true }).deps)).status).toBe(401)
    expect((await handleMaps(req({ op: 'drop table' }), fake().deps)).status).toBe(400)
    expect((await handleMaps(new Request('https://fn/maps', { method: 'GET' }), fake().deps)).status).toBe(405)
  })
  it('reports whether it is configured without ever revealing the key', async () => {
    const on = await (await handleMaps(req({ op: 'status' }), fake().deps)).json()
    expect(on).toEqual({ configured: true, browser_key: null })
    expect(JSON.stringify(on)).not.toContain(ENV.GOOGLE_MAPS_SERVER_KEY)
    const off = fake({}, { ...ENV, GOOGLE_MAPS_SERVER_KEY: undefined })
    expect(await (await handleMaps(req({ op: 'status' }), off.deps)).json()).toEqual({ configured: false, browser_key: null })
    const r = await handleMaps(req({ op: 'autocomplete', q: 'rooftop' }), off.deps)
    expect(r.status).toBe(503); expect(((await r.json()) as { error: string }).error).toBe('maps_unavailable')
    expect(googleCalls(off.calls)).toHaveLength(0)                       // nothing was fabricated or sent
  })
  it('hands out only the public browser key (for the interactive map), never the server key', async () => {
    const f = fake({}, { ...ENV, GOOGLE_MAPS_BROWSER_KEY: 'AIzaBrowserKeyRestrictedToTheSite123' })
    const body = await (await handleMaps(req({ op: 'status' }), f.deps)).json()
    expect(body).toEqual({ configured: true, browser_key: 'AIzaBrowserKeyRestrictedToTheSite123' })
    expect(JSON.stringify(body)).not.toContain(ENV.GOOGLE_MAPS_SERVER_KEY)
    expect(googleCalls(f.calls)).toHaveLength(0)
  })
  it('rate limits per member through the database before calling Google', async () => {
    const f = fake({ gate: { ok: false } })
    const r = await handleMaps(req({ op: 'autocomplete', q: 'rooftop' }), f.deps)
    expect(r.status).toBe(429); expect(googleCalls(f.calls)).toHaveLength(0)
  })
  it('autocomplete validates input and returns only the fields the UI needs', async () => {
    expect((await handleMaps(req({ op: 'autocomplete', q: 'a' }), fake().deps)).status).toBe(400)
    expect((await handleMaps(req({ op: 'autocomplete', q: 'x'.repeat(81) }), fake().deps)).status).toBe(400)
    const f = fake({ google: { status: 200, body: { suggestions: [{ placePrediction: { placeId: 'ChIJabcdefghij', text: { text: 'The Roof, Cape Town' }, structuredFormat: { mainText: { text: 'The Roof' }, secondaryText: { text: 'Cape Town' } } }, secret: 'x' }, { queryPrediction: {} }] } } })
    const r = await handleMaps(req({ op: 'autocomplete', q: 'the roof', near: { lat: -33.9, lng: 18.4 } }), f.deps)
    expect(await r.json()).toEqual({ results: [{ place_id: 'ChIJabcdefghij', text: 'The Roof, Cape Town', main: 'The Roof', secondary: 'Cape Town' }] })
    const g = googleCalls(f.calls)[0]
    expect(g.headers['x-goog-api-key']).toBe('AIza-secret-key'); expect(g.url).not.toContain('AIza'); expect(g.body).toContain('locationBias')
  })
  it('place details reject malformed ids and normalise the response', async () => {
    expect((await handleMaps(req({ op: 'place', place_id: '../etc/passwd' }), fake().deps)).status).toBe(400)
    const f = fake({ google: { status: 200, body: { displayName: { text: 'The Roof' }, formattedAddress: '1 Long St', location: { latitude: -33.92, longitude: 18.42 }, addressComponents: [{ longText: 'Cape Town', types: ['locality'] }, { longText: 'South Africa', types: ['country'] }] } } })
    expect(await (await handleMaps(req({ op: 'place', place_id: 'ChIJabcdefghij' }), f.deps)).json()).toEqual({ name: 'The Roof', address: '1 Long St', lat: -33.92, lng: 18.42, city: 'Cape Town', country: 'South Africa' })
  })
  it('route validates coordinates and returns real distance/duration only', async () => {
    expect((await handleMaps(req({ op: 'route', origin: { lat: 999, lng: 0 }, dest: { lat: 1, lng: 1 } }), fake().deps)).status).toBe(400)
    expect((await handleMaps(req({ op: 'route', origin: { lat: 1, lng: 1 } }), fake().deps)).status).toBe(400)
    const f = fake({ google: { status: 200, body: { routes: [{ duration: '1260s', distanceMeters: 15400, polyline: { encodedPolyline: 'abc' } }] } } })
    const r = await handleMaps(req({ op: 'route', origin: { lat: -26.2, lng: 28.04 }, dest: { lat: -26.1, lng: 28.1 }, mode: 'WALK' }), f.deps)
    expect(await r.json()).toEqual({ distance_m: 15400, duration_s: 1260, mode: 'WALK', polyline: 'abc' })
    expect(JSON.parse(googleCalls(f.calls)[0].body).travelMode).toBe('WALK')
    const none = await handleMaps(req({ op: 'route', origin: { lat: 1, lng: 1 }, dest: { lat: 2, lng: 2 } }), fake({ google: { status: 200, body: {} } }).deps)
    expect(none.status).toBe(404)                                          // no invented route
  })
  it('static map: validates markers, hides the key from the URL the browser sees, returns image bytes', async () => {
    expect((await handleMaps(req({ op: 'static', markers: [] }), fake().deps)).status).toBe(400)
    expect((await handleMaps(req({ op: 'static', markers: [{ lat: 'x', lng: 1 }] }), fake().deps)).status).toBe(400)
    const f = fake({ google: { status: 200, body: null, image: true } })
    const r = await handleMaps(req({ op: 'static', markers: [{ lat: -26.2, lng: 28.04 }], w: 9999, h: 5 }), f.deps)
    expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('image/png'); expect(r.headers.get('cache-control')).toContain('private')
    const url = googleCalls(f.calls)[0].url
    expect(url).toContain('size=640x100'); expect(url).toContain('key=AIza-secret-key')
  })
  it('turns Google failures into generic errors that never echo the key or the upstream body', async () => {
    const denied = await handleMaps(req({ op: 'autocomplete', q: 'roof' }), fake({ google: { status: 403, body: { error: { message: 'API key AIza-secret-key not authorised' } } } }).deps)
    const txt = await denied.text()
    expect(denied.status).toBe(502); expect(txt).not.toContain('AIza'); expect(txt).toContain('maps_denied')
    const boom = { ...fake().deps, fetch: (async (u: string) => { if (String(u).endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1' })); if (String(u).endsWith('/rpc/maps_gate')) return new Response('null'); throw new Error('network down AIza-secret-key') }) as unknown as typeof fetch }
    const r = await handleMaps(req({ op: 'autocomplete', q: 'roof' }), boom)
    expect(r.status).toBe(502); expect(await r.text()).not.toContain('AIza')
  })
})
