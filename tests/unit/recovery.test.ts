import { describe, expect, it } from 'vitest'
import { handleChatRecovery, publicOf, seal, unseal } from '../../supabase/functions/_shared/handlers/recovery.ts'
import type { Deps } from '../../supabase/functions/_shared/http.ts'

const UID = 'aaaaaaaa-0000-4000-8000-000000000001', SECRET = 's'.repeat(40), PW = 'correct-password'
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
const HOUR = 3600_000

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return { pkcs8, pub: await publicOf(pkcs8) }
}

/** A small in-memory Supabase (Auth + the tables the function touches). */
function world(opts: { secret?: string; hours?: string } = {}) {
  const db = { keys: new Map<string, string>(), escrow: new Map<string, string>(), backups: new Map<string, { escrow: boolean }>(), requests: [] as Record<string, any>[], events: [] as { user_id: string; action: string; created_at: string }[] }
  let clock = Date.UTC(2026, 9, 21, 12)
  const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', CHAT_ESCROW_SECRET: opts.secret ?? SECRET, ...(opts.hours ? { RECOVERY_DELAY_HOURS: opts.hours } : {}) }
  const j = (b: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  const q = (u: URL, k: string) => u.searchParams.get(k)?.replace(/^(eq|gte)\./, '') ?? null
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input)), m = init.method ?? 'GET', path = u.pathname, body = init.body ? JSON.parse(String(init.body)) : null
    if (path === '/auth/v1/user') return (init.headers as Record<string, string>).authorization === 'Bearer good' ? j({ id: UID, email: 'a@example.com', user_metadata: {} }) : j({}, 401)
    if (path === '/auth/v1/token') return body.password === PW ? j({ access_token: 'x' }) : j({ error: 'invalid' }, 400)
    if (path === '/rest/v1/rpc/chat_security_event') { db.events.push({ user_id: body.p_user, action: body.p_action, created_at: new Date(clock).toISOString() }); return j(null, 204) }
    if (path === '/rest/v1/rpc/expire_recovery_requests') { for (const r of db.requests) if (r.status === 'waiting' && new Date(r.expires_at).getTime() < clock) r.status = 'expired'; return j(null, 204) }
    if (path === '/rest/v1/chat_keys') return j(db.keys.has(q(u, 'user_id')!) ? [{ public_key: db.keys.get(q(u, 'user_id')!) }] : [])
    if (path === '/rest/v1/chat_key_escrow') {
      if (m === 'POST') { db.escrow.set(body.user_id, body.blob); return j(null, 201) }
      if (m === 'DELETE') { db.escrow.delete(q(u, 'user_id')!); return j(null, 204) }
      return j(db.escrow.has(q(u, 'user_id')!) ? [{ user_id: q(u, 'user_id'), blob: db.escrow.get(q(u, 'user_id')!) }] : [])
    }
    if (path === '/rest/v1/chat_key_backups') { if (m === 'PATCH') db.backups.set(q(u, 'user_id')!, { escrow: body.escrow }); return j(null, 204) }
    if (path === '/rest/v1/chat_key_events') {
      const since = new Date(q(u, 'created_at')!).getTime()
      return j(db.events.filter(e => e.user_id === q(u, 'user_id') && e.action === q(u, 'action') && new Date(e.created_at).getTime() >= since).map(() => ({ id: 'x' })))
    }
    if (path === '/rest/v1/chat_recovery_requests') {
      if (m === 'POST') {
        if (db.requests.some(r => r.user_id === body.user_id && r.status === 'waiting')) return j({ message: 'duplicate key value violates unique constraint' }, 409)
        const row = { id: crypto.randomUUID(), status: 'waiting', created_at: new Date(clock).toISOString(), ...body }; db.requests.push(row); return j([row], 201)
      }
      if (m === 'PATCH') { for (const r of db.requests) if ((!q(u, 'id') || r.id === q(u, 'id')) && r.user_id !== undefined && (!q(u, 'user_id') || r.user_id === q(u, 'user_id')) && r.status === (q(u, 'status') ?? r.status)) Object.assign(r, body); return j(null, 204) }
      const id = q(u, 'id'), since = q(u, 'created_at')
      return j(db.requests.filter(r => r.user_id === q(u, 'user_id') && (!id || r.id === id) && (!since || new Date(r.created_at).getTime() >= new Date(since).getTime())))
    }
    return j({}, 404)
  }) as typeof fetch
  const deps: Deps = { env, fetch: fetchFn, now: () => clock }
  const call = (body: unknown, token = 'good') => handleChatRecovery(new Request('https://f/chat-recovery', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), deps)
  return { db, call, deps, advance: (ms: number) => { clock += ms }, now: () => clock }
}

describe('chat-recovery (opt-in VYBE-assisted recovery)', () => {
  it('seals a key with the server secret and opens it only with the same secret and the same member', async () => {
    const { pkcs8 } = await identity()
    const blob = await seal(SECRET, UID, pkcs8)
    expect(blob.startsWith('v1.')).toBe(true); expect(blob).not.toContain(b64(pkcs8).slice(0, 20))
    expect(Buffer.from(await unseal(SECRET, UID, blob)).equals(Buffer.from(pkcs8))).toBe(true)
    await expect(unseal('t'.repeat(40), UID, blob)).rejects.toThrow()                                              // a leaked database alone is not enough
    await expect(unseal(SECRET, 'bbbbbbbb-0000-4000-8000-000000000002', blob)).rejects.toThrow()                  // not usable for another member
  })

  it('requires sign-in and reports whether the feature is configured', async () => {
    const w = world()
    expect((await w.call({ action: 'available' }, 'bad')).status).toBe(401)
    expect(await (await w.call({ action: 'available' })).json()).toEqual({ available: true })
    expect(await (await world({ secret: 'short' }).call({ action: 'available' })).json()).toEqual({ available: false })
    expect((await world({ secret: 'short' }).call({ action: 'enable', pkcs8: 'x' })).status).toBe(503)
  })

  it('enable stores only the sealed key, refuses a key that is not the published one, and logs it', async () => {
    const w = world(), id = await identity(), other = await identity()
    expect((await w.call({ action: 'enable', pkcs8: b64(id.pkcs8) })).status).toBe(400)                              // no secure chat yet
    w.db.keys.set(UID, id.pub)
    expect((await w.call({ action: 'enable', pkcs8: b64(other.pkcs8) })).status).toBe(400)                           // someone else's key
    expect((await w.call({ action: 'enable', pkcs8: b64(id.pkcs8) })).status).toBe(200)
    const blob = w.db.escrow.get(UID)!
    expect(blob).not.toContain(b64(id.pkcs8).slice(0, 20)); expect(w.db.backups.get(UID)).toEqual({ escrow: true }); expect(w.db.events.map(e => e.action)).toContain('escrow_on')
  })

  async function enabled(hours?: string) {
    const w = world({ hours }), id = await identity(); w.db.keys.set(UID, id.pub); await w.call({ action: 'enable', pkcs8: b64(id.pkcs8) }); return { w, id }
  }

  it('a recovery needs the password, then waits (72 h by default) before anything is released', async () => {
    const { w, id } = await enabled()
    const bad = await w.call({ action: 'request', password: 'nope' })
    expect(bad.status).toBe(403); expect(w.db.events.some(e => e.action === 'recovery_failed')).toBe(true); expect(w.db.requests).toHaveLength(0)
    const ok = await (await w.call({ action: 'request', password: PW })).json() as { id: string; ready_at: string }
    expect(new Date(ok.ready_at).getTime() - w.now()).toBe(72 * HOUR); expect(w.db.events.map(e => e.action)).toContain('recovery_requested')
    const early = await w.call({ action: 'complete', id: ok.id, password: PW })
    expect(early.status).toBe(425); expect((await early.json() as { pkcs8?: string }).pkcs8).toBeUndefined()
    w.advance(72 * HOUR + 1000)
    const wrongPw = await w.call({ action: 'complete', id: ok.id, password: 'nope' }); expect(wrongPw.status).toBe(403)
    const done = await w.call({ action: 'complete', id: ok.id, password: PW })
    expect(done.status).toBe(200)
    expect(Buffer.from((await done.json() as { pkcs8: string }).pkcs8, 'base64').equals(Buffer.from(id.pkcs8))).toBe(true)
    expect(w.db.requests[0].status).toBe('completed'); expect(w.db.events.map(e => e.action)).toContain('recovery_completed')
    expect((await w.call({ action: 'complete', id: ok.id, password: PW })).status).toBe(409)                       // single use
  })

  it('only one recovery can wait at a time, and it can be cancelled, expired or invalidated', async () => {
    const { w } = await enabled('24')
    const first = await (await w.call({ action: 'request', password: PW })).json() as { id: string; ready_at: string }
    expect(new Date(first.ready_at).getTime() - w.now()).toBe(24 * HOUR)
    expect((await w.call({ action: 'request', password: PW })).status).toBe(409)
    w.db.requests[0].status = 'cancelled'                                                                          // "this wasn't me" from another device
    w.advance(25 * HOUR)
    expect((await w.call({ action: 'complete', id: first.id, password: PW })).status).toBe(409)
    const second = await (await w.call({ action: 'request', password: PW })).json() as { id: string }
    w.advance((24 + 7 * 24 + 1) * HOUR)                                                                            // never collected
    expect((await w.call({ action: 'complete', id: second.id, password: PW })).status).toBe(409)
  })

  it('five wrong passwords lock the endpoint; requests are capped per month; nothing without escrow', async () => {
    const { w } = await enabled()
    for (let i = 0; i < 5; i++) await w.call({ action: 'request', password: 'nope' })
    expect((await w.call({ action: 'request', password: PW })).status).toBe(429)                                   // even the right password is refused while locked
    w.advance(61 * 60_000)
    expect((await w.call({ action: 'request', password: PW })).status).toBe(200)
    const none = world(); none.db.keys.set(UID, (await identity()).pub)
    expect((await none.call({ action: 'request', password: PW })).status).toBe(400)
    const capped = (await enabled()).w
    for (let i = 0; i < 3; i++) { await capped.call({ action: 'request', password: PW }); capped.db.requests[i].status = 'cancelled'; capped.advance(60_000) }
    expect((await capped.call({ action: 'request', password: PW })).status).toBe(429)
  })

  it('a tampered or mismatched stored copy is never released', async () => {
    const { w } = await enabled()
    const { id } = await (await w.call({ action: 'request', password: PW })).json() as { id: string }
    w.advance(73 * HOUR)
    w.db.escrow.set(UID, await seal(SECRET, UID, (await identity()).pkcs8))                                        // a copy of some other key was swapped in
    const r = await w.call({ action: 'complete', id, password: PW })
    expect(r.status).toBe(500); expect((await r.json() as { pkcs8?: string }).pkcs8).toBeUndefined(); expect(w.db.requests[0].status).toBe('waiting')
    w.db.escrow.set(UID, 'v1.AAAA.BBBB')
    expect((await w.call({ action: 'complete', id, password: PW })).status).toBe(500)
  })

  it('disable removes the stored copy and stops any recovery in progress', async () => {
    const { w } = await enabled()
    await w.call({ action: 'request', password: PW })
    expect((await w.call({ action: 'disable' })).status).toBe(200)
    expect(w.db.escrow.has(UID)).toBe(false); expect(w.db.backups.get(UID)).toEqual({ escrow: false }); expect(w.db.requests[0].status).toBe('cancelled'); expect(w.db.events.map(e => e.action)).toContain('escrow_off')
  })
})
