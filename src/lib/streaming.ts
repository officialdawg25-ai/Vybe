import { callFunction } from './functions'

/**
 * Live streaming runs on LiveKit. The browser never holds a LiveKit secret: it asks the `livekit-token` edge function for a
 * short-lived token, and that function asks the database (as the signed-in user) whether they may watch or broadcast.
 */
export interface LiveToken { token: string; url: string; room: string; role: 'host' | 'viewer'; name: string; title: string }

export const getLiveToken = (streamId: string, publish: boolean) => callFunction<LiveToken>('livekit-token', { stream_id: streamId, publish })
export const liveControl = (streamId: string, action: 'end' | 'ban', userId?: string) => callFunction<{ ok: true }>('livekit-control', { stream_id: streamId, action, user_id: userId })

/** Chat / reaction messages travel over LiveKit's data channel. Everything received is untrusted and re-validated. */
export type LiveMsg = { t: 'chat'; m: string } | { t: 'react' }
export const MAX_CHAT = 200
export function parseMsg(raw: Uint8Array): LiveMsg | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as { t?: unknown; m?: unknown }
    if (o.t === 'react') return { t: 'react' }
    if (o.t === 'chat' && typeof o.m === 'string') { const m = o.m.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHAT); return m ? { t: 'chat', m } : null }
  } catch { /* not ours */ }
  return null
}
export const encodeMsg = (m: LiveMsg) => new TextEncoder().encode(JSON.stringify(m))
