import { dbError, json, need, preflight, service, sha256Hex, clientIp, whoami, type Caller, type Deps } from '../http.ts'

/**
 * Opt-in VYBE-assisted recovery of a member's chat key ("escrow"). Be clear about what this is: the member hands their chat private key to this
 * function, which seals it with AES-256-GCM under a key derived from the CHAT_ESCROW_SECRET function secret and stores it in a table no browser
 * role can read. Anyone who holds BOTH the database and that secret could open it, so members who enable this trade strict end-to-end
 * encryption for recoverability. Everything else is built to make abuse hard:
 *   - release needs the account password again, a waiting period (default 72 h), and the request can be cancelled from any device;
 *   - the member is alerted (in-app notification + security log) when it is switched on, requested, completed or switched off;
 *   - repeated wrong passwords lock the endpoint for the account; requests are capped per month;
 *   - the stored key is checked against the member's published public key before it is sealed and again before it is released.
 */
const te = new TextEncoder()
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
const UUID = /^[0-9a-f-]{36}$/i

export const MIN_SECRET = 32
const wrapKey = async (secret: string, uid: string) =>
  crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ab(te.encode('vybe-escrow-v1')), info: ab(te.encode(uid)) }, await crypto.subtle.importKey('raw', ab(te.encode(secret)), 'HKDF', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
export async function seal(secret: string, uid: string, pkcs8: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv), additionalData: ab(te.encode(uid)) }, await wrapKey(secret, uid), ab(pkcs8)))
  return `v1.${b64(iv)}.${b64(ct)}`
}
export async function unseal(secret: string, uid: string, blob: string): Promise<Uint8Array> {
  const [v, iv, ct] = blob.split('.')
  if (v !== 'v1' || !iv || !ct) throw new Error('bad blob')
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(unb64(iv)), additionalData: ab(te.encode(uid)) }, await wrapKey(secret, uid), ab(unb64(ct))))
}
/** The public key (base64 raw point) that belongs to a PKCS#8 P-256 private key. */
export async function publicOf(pkcs8: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('pkcs8', ab(pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', k)
  const x = unb64(jwk.x!.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((jwk.x!.length + 3) % 4)), y = unb64(jwk.y!.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((jwk.y!.length + 3) % 4))
  const raw = new Uint8Array(65); raw[0] = 4; raw.set(x, 1); raw.set(y, 33)
  return b64(raw)
}

const HOUR = 3600_000
async function rows<T>(r: Response): Promise<T[]> { return r.ok ? ((await r.json().catch(() => [])) as T[]) : [] }

/** Checks the password against Supabase Auth without touching the caller's own session. */
async function passwordOk(deps: Deps, email: string, password: string): Promise<boolean> {
  if (!email || !password) return false
  const r = await deps.fetch(`${deps.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: deps.env.SUPABASE_ANON_KEY ?? deps.env.SUPABASE_SERVICE_ROLE_KEY!, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  return r.ok
}

export async function handleChatRecovery(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  const body = (await req.json().catch(() => ({}))) as { action?: string; pkcs8?: string; password?: string; id?: string }
  const secret = deps.env.CHAT_ESCROW_SECRET ?? ''
  const configured = need(deps.env, 'CHAT_ESCROW_SECRET').length === 0 && secret.length >= MIN_SECRET
  if (body.action === 'available') return json({ available: configured })
  if (!configured) return json({ error: 'VYBE-assisted recovery is not set up on this server.' }, 503)
  const svc = service(deps), now = deps.now?.() ?? Date.now()
  const event = (action: string, detail: Record<string, unknown> = {}) => svc.rpc('chat_security_event', { p_user: me.id, p_action: action, p_detail: detail })
  switch (body.action) {
    case 'enable': return enable(deps, me, body.pkcs8, secret, event)
    case 'disable': return disable(me, svc, event)
    case 'request': return request(req, deps, me, body.password, svc, event, now)
    case 'complete': return complete(deps, me, body.id, body.password, secret, svc, event, now)
    default: return json({ error: 'Unknown action.' }, 400)
  }
}

type Svc = ReturnType<typeof service>
type Event = (action: string, detail?: Record<string, unknown>) => Promise<Response>

async function enable(deps: Deps, me: Caller, pkcs8: string | undefined, secret: string, event: Event): Promise<Response> {
  if (!pkcs8 || pkcs8.length > 600) return json({ error: 'Missing key.' }, 400)
  const svc = service(deps)
  const published = (await rows<{ public_key: string }>(await svc.rest(`/rest/v1/chat_keys?user_id=eq.${me.id}&select=public_key`)))[0]?.public_key
  if (!published) return json({ error: 'Turn on secure chat first.' }, 400)
  let raw: Uint8Array
  try { raw = unb64(pkcs8); if ((await publicOf(raw)) !== published) throw new Error('mismatch') } catch { return json({ error: 'That key does not match your secure chat key.' }, 400) }
  const blob = await seal(secret, me.id, raw)
  const put = await svc.rest('/rest/v1/chat_key_escrow?on_conflict=user_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: me.id, blob }) })
  if (!put.ok) return json({ error: await dbError(put, 'Could not save the recovery copy.') }, 500)
  await svc.rest(`/rest/v1/chat_key_backups?user_id=eq.${me.id}`, { method: 'PATCH', body: JSON.stringify({ escrow: true }) })
  await event('escrow_on')
  return json({ ok: true })
}

async function disable(me: Caller, svc: Svc, event: Event): Promise<Response> {
  await svc.rest(`/rest/v1/chat_key_escrow?user_id=eq.${me.id}`, { method: 'DELETE' })
  await svc.rest(`/rest/v1/chat_key_backups?user_id=eq.${me.id}`, { method: 'PATCH', body: JSON.stringify({ escrow: false }) })
  await svc.rest(`/rest/v1/chat_recovery_requests?user_id=eq.${me.id}&status=eq.waiting`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }) })
  await event('escrow_off')
  return json({ ok: true })
}

/** Counts wrong passwords in the last hour; at five the account is locked out of this endpoint for a while. */
async function locked(svc: Svc, uid: string, now: number) {
  const since = new Date(now - HOUR).toISOString()
  const n = (await rows<{ id: string }>(await svc.rest(`/rest/v1/chat_key_events?user_id=eq.${uid}&action=eq.recovery_failed&created_at=gte.${since}&select=id`))).length
  return n >= 5
}

async function request(req: Request, deps: Deps, me: Caller, password: string | undefined, svc: Svc, event: Event, now: number): Promise<Response> {
  if (await locked(svc, me.id, now)) return json({ error: 'Too many wrong passwords. Try again in an hour.' }, 429)
  if (!(await passwordOk(deps, me.email, password ?? ''))) { await event('recovery_failed', { step: 'request' }); return json({ error: 'That password is not right.' }, 403) }
  await svc.rpc('expire_recovery_requests', {})
  const escrow = (await rows<{ user_id: string }>(await svc.rest(`/rest/v1/chat_key_escrow?user_id=eq.${me.id}&select=user_id`)))[0]
  if (!escrow) return json({ error: 'VYBE-assisted recovery was not turned on for this account, so there is nothing to recover.' }, 400)
  const month = new Date(now - 30 * 24 * HOUR).toISOString()
  const recent = (await rows<{ id: string }>(await svc.rest(`/rest/v1/chat_recovery_requests?user_id=eq.${me.id}&created_at=gte.${month}&select=id`))).length
  if (recent >= 3) return json({ error: 'You have asked to recover too often this month. Contact support.' }, 429)
  const hours = Math.min(Math.max(Number(deps.env.RECOVERY_DELAY_HOURS ?? 72) || 72, 1), 24 * 14)
  const ready = new Date(now + hours * HOUR), expires = new Date(now + (hours + 7 * 24) * HOUR)
  const ins = await svc.rest('/rest/v1/chat_recovery_requests', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ user_id: me.id, ready_at: ready.toISOString(), expires_at: expires.toISOString(), ip_hash: await sha256Hex(clientIp(req) || 'unknown') }) })
  if (!ins.ok) return json({ error: ins.status === 409 ? 'A recovery is already waiting. Check your notifications.' : await dbError(ins, 'Could not start the recovery.') }, ins.status === 409 ? 409 : 500)
  const row = (await rows<{ id: string; ready_at: string }>(ins))[0]
  await event('recovery_requested', { ready_at: ready.toISOString(), hours })
  return json({ id: row?.id, ready_at: ready.toISOString() })
}

async function complete(deps: Deps, me: Caller, id: string | undefined, password: string | undefined, secret: string, svc: Svc, event: Event, now: number): Promise<Response> {
  if (!id || !UUID.test(id)) return json({ error: 'Missing request.' }, 400)
  if (await locked(svc, me.id, now)) return json({ error: 'Too many wrong passwords. Try again in an hour.' }, 429)
  if (!(await passwordOk(deps, me.email, password ?? ''))) { await event('recovery_failed', { step: 'complete' }); return json({ error: 'That password is not right.' }, 403) }
  await svc.rpc('expire_recovery_requests', {})
  const r = (await rows<{ id: string; status: string; ready_at: string; expires_at: string }>(await svc.rest(`/rest/v1/chat_recovery_requests?id=eq.${id}&user_id=eq.${me.id}&select=id,status,ready_at,expires_at`)))[0]
  if (!r || r.status !== 'waiting') return json({ error: 'This recovery is no longer active.' }, 409)
  if (new Date(r.expires_at).getTime() < now) return json({ error: 'This recovery expired. Start a new one.' }, 409)
  if (new Date(r.ready_at).getTime() > now) return json({ error: 'The waiting period is not over yet.', ready_at: r.ready_at }, 425)
  const blob = (await rows<{ blob: string }>(await svc.rest(`/rest/v1/chat_key_escrow?user_id=eq.${me.id}&select=blob`)))[0]?.blob
  const published = (await rows<{ public_key: string }>(await svc.rest(`/rest/v1/chat_keys?user_id=eq.${me.id}&select=public_key`)))[0]?.public_key
  if (!blob || !published) return json({ error: 'There is no recovery copy to release.' }, 409)
  let pkcs8: Uint8Array
  try { pkcs8 = await unseal(secret, me.id, blob); if ((await publicOf(pkcs8)) !== published) throw new Error('mismatch') } catch { await event('recovery_failed', { step: 'integrity' }); return json({ error: 'The recovery copy could not be verified, so it was not released.' }, 500) }
  const done = await svc.rest(`/rest/v1/chat_recovery_requests?id=eq.${id}&status=eq.waiting`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', updated_at: new Date(now).toISOString() }) })
  if (!done.ok) return json({ error: 'Could not finish the recovery. Try again.' }, 500)
  await event('recovery_completed')
  return json({ pkcs8: b64(pkcs8) })
}
