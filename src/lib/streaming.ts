import { callFunction } from './functions'

/**
 * Live streaming runs on LiveKit. The browser never holds a LiveKit secret: it asks the `livekit-token` edge function for a
 * short-lived token, and that function asks the database (as the signed-in user) whether they may watch or broadcast.
 */
export interface LiveToken { token: string; url: string; room: string; role: 'host' | 'guest' | 'viewer'; name: string; title: string }

export const getLiveToken = (streamId: string, publish: boolean) => callFunction<LiveToken>('livekit-token', { stream_id: streamId, publish })
export const liveControl = (streamId: string, action: 'end' | 'ban' | 'guest_add' | 'guest_remove' | 'guest_leave', userId?: string) => callFunction<{ ok: true }>('livekit-control', { stream_id: streamId, action, user_id: userId })

/**
 * Everything on a live besides audio/video travels over LiveKit's data channel: text chat (no voice or video notes on a live),
 * emoji reactions, requests to join the stage, the host's pinned comment and live polls. Everything received is untrusted:
 * parsed strictly here, and host-only messages (pin, poll, tally) are acted on only when they come from the host's identity.
 */
export const REACTIONS = ['❤️', '🔥', '😂', '👏', '😮', '💜'] as const
export type Reaction = typeof REACTIONS[number]
export type LiveMsg =
  | { t: 'chat'; m: string }
  | { t: 'react'; e: Reaction }
  | { t: 'join' } | { t: 'join_cancel' }
  | { t: 'pin'; m: string; n: string; f?: string } | { t: 'unpin' }
  | { t: 'poll'; id: string; q: string; o: string[] } | { t: 'vote'; id: string; i: number } | { t: 'tally'; id: string; c: number[] } | { t: 'poll_end'; id: string }
export const MAX_CHAT = 200
export const MAX_POLL_Q = 100, MAX_POLL_OPT = 40
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const pid = (v: unknown) => (typeof v === 'string' && /^[a-z0-9]{6,16}$/i.test(v) ? v : null)
export function parseMsg(raw: Uint8Array): LiveMsg | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
    switch (o.t) {
      case 'chat': { const m = clean(o.m, MAX_CHAT); return m ? { t: 'chat', m } : null }
      case 'react': return { t: 'react', e: (REACTIONS as readonly string[]).includes(o.e as string) ? (o.e as Reaction) : '❤️' }
      case 'join': return { t: 'join' }
      case 'join_cancel': return { t: 'join_cancel' }
      case 'pin': { const m = clean(o.m, MAX_CHAT), n = clean(o.n, 60), f = typeof o.f === 'string' && /^[0-9a-f-]{36}$/i.test(o.f) ? o.f : undefined; return m ? { t: 'pin', m, n, ...(f ? { f } : {}) } : null }
      case 'unpin': return { t: 'unpin' }
      case 'poll': {
        const id = pid(o.id), q = clean(o.q, MAX_POLL_Q), opts = Array.isArray(o.o) ? o.o.map(x => clean(x, MAX_POLL_OPT)).filter(Boolean) : []
        return id && q && opts.length >= 2 && opts.length <= 4 ? { t: 'poll', id, q, o: opts } : null
      }
      case 'vote': { const id = pid(o.id), i = o.i; return id && Number.isInteger(i) && (i as number) >= 0 && (i as number) < 4 ? { t: 'vote', id, i: i as number } : null }
      case 'tally': { const id = pid(o.id), c = o.c; return id && Array.isArray(c) && c.length >= 2 && c.length <= 4 && c.every(n => Number.isInteger(n) && n >= 0 && n < 1e7) ? { t: 'tally', id, c: c as number[] } : null }
      case 'poll_end': { const id = pid(o.id); return id ? { t: 'poll_end', id } : null }
    }
  } catch { /* not ours */ }
  return null
}
export const encodeMsg = (m: LiveMsg) => new TextEncoder().encode(JSON.stringify(m))

/** Host side of a poll: one vote per person (changing your vote moves it), counts per option. Pure, so it is unit-tested. */
export function tallyVotes(votes: ReadonlyMap<string, number>, options: number): number[] {
  const c = Array.from({ length: options }, () => 0)
  for (const i of votes.values()) if (i >= 0 && i < options) c[i]++
  return c
}
