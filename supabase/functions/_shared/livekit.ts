/** Minimal LiveKit server helpers (access tokens, webhook verification, RoomService calls) with no SDK dependency. */
import type { Deps } from './http.ts'

const enc = new TextEncoder()
const b64url = (u: Uint8Array | string) => {
  const bytes = typeof u === 'string' ? enc.encode(u) : u
  let s = ''; for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0))

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

export interface VideoGrant {
  room?: string; roomJoin?: boolean; canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean
  roomCreate?: boolean; roomAdmin?: boolean; roomList?: boolean; hidden?: boolean
  /** Limits what may be published (LiveKit source names, e.g. 'camera', 'microphone'). */
  canPublishSources?: string[]
}
export interface TokenOpts { apiKey: string; secret: string; identity?: string; name?: string; metadata?: string; video: VideoGrant; ttlSec?: number; now?: number }

/** HS256 JWT in LiveKit's access-token format. */
export async function signToken(o: TokenOpts): Promise<string> {
  const now = Math.floor((o.now ?? Date.now()) / 1000)
  const payload: Record<string, unknown> = { iss: o.apiKey, nbf: now - 5, exp: now + (o.ttlSec ?? 7200), video: o.video }
  if (o.identity) payload.sub = o.identity
  if (o.name) payload.name = o.name
  if (o.metadata) payload.metadata = o.metadata
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64url(JSON.stringify(payload))
  return `${head}.${body}.${b64url(await hmac(o.secret, `${head}.${body}`))}`
}

export async function verifyJwt(token: string, secret: string, now = Date.now()): Promise<Record<string, unknown> | null> {
  const [h, p, sig] = token.split('.')
  if (!h || !p || !sig) return null
  const expect = b64url(await hmac(secret, `${h}.${p}`))
  if (expect.length !== sig.length) return null
  let d = 0; for (let i = 0; i < sig.length; i++) d |= expect.charCodeAt(i) ^ sig.charCodeAt(i)
  if (d !== 0) return null
  try {
    const claims = JSON.parse(new TextDecoder().decode(unb64url(p))) as Record<string, unknown>
    const t = Math.floor(now / 1000)
    if (typeof claims.exp === 'number' && claims.exp < t) return null
    if (typeof claims.nbf === 'number' && claims.nbf > t + 30) return null
    return claims
  } catch { return null }
}

/** LiveKit signs webhooks with a JWT whose `sha256` claim is the base64 SHA-256 of the raw body. */
export async function verifyWebhook(authHeader: string | null, body: string, apiKey: string, secret: string, now = Date.now()) {
  if (!authHeader) return false
  const claims = await verifyJwt(authHeader.replace(/^Bearer\s+/i, ''), secret, now)
  if (!claims || claims.iss !== apiKey) return false
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body)))
  let s = ''; for (const b of digest) s += String.fromCharCode(b)
  const b64 = btoa(s)
  return typeof claims.sha256 === 'string' && (claims.sha256 === b64 || claims.sha256 === b64url(digest))
}

export const httpUrl = (wsUrl: string) => wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '')

/** RoomService (Twirp/JSON) call with a short-lived admin token. */
export async function roomService(deps: Deps, method: string, body: Record<string, unknown>, room?: string): Promise<Response> {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = deps.env
  const token = await signToken({ apiKey: LIVEKIT_API_KEY!, secret: LIVEKIT_API_SECRET!, ttlSec: 60, video: { roomCreate: true, roomList: true, roomAdmin: true, room }, now: deps.now?.() })
  return deps.fetch(`${httpUrl(LIVEKIT_URL!)}/twirp/livekit.RoomService/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
