import { asUser, dbError, json, need, preflight, service, text, whoami, type Deps } from '../http.ts'
import { roomService, signToken, verifyWebhook } from '../livekit.ts'

const LK = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']

/** POST {stream_id, publish?} → LiveKit access token. Every rule is decided by live_token_gate() running as the caller. */
export async function handleLiveToken(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in to watch.' }, 401)
  if (need(deps.env, ...LK).length) return json({ error: 'Live streaming is not configured yet.' }, 503)
  const { stream_id, publish, call_id } = (await req.json().catch(() => ({}))) as { stream_id?: string; publish?: boolean; call_id?: string }
  if (call_id !== undefined) return callToken(deps, me, call_id)
  if (!stream_id || !/^[0-9a-f-]{36}$/i.test(stream_id)) return json({ error: 'Missing stream.' }, 400)

  const gate = await asUser(deps, me.token).rpc('live_token_gate', { sid: stream_id, want_publish: Boolean(publish) })
  if (!gate.ok) return json({ error: await dbError(gate, 'This stream is not available.') }, gate.status === 401 ? 401 : 403)
  const g = (await gate.json()) as { room: string; role: 'host' | 'guest' | 'viewer'; name: string; title: string; status: string }

  if (g.role === 'host') {   // the room is created up front with a ceiling on viewers and an auto-close when empty
    const max = Number(deps.env.LIVE_MAX_VIEWERS ?? 2000)
    await roomService(deps, 'CreateRoom', { name: g.room, empty_timeout: 300, max_participants: max + 1 }, g.room).catch(() => null)
  }
  const token = await signToken({
    apiKey: deps.env.LIVEKIT_API_KEY!, secret: deps.env.LIVEKIT_API_SECRET!, identity: me.id, name: g.name, ttlSec: g.role === 'host' ? 6 * 3600 : 2 * 3600, now: deps.now?.(),
    metadata: JSON.stringify({ role: g.role }),
    // A guest the host put on stage may send camera and microphone only (no screen share); viewers send chat only.
    video: { room: g.room, roomJoin: true, canSubscribe: true, canPublish: g.role !== 'viewer', canPublishData: true, ...(g.role === 'guest' ? { canPublishSources: ['camera', 'microphone'] } : {}) },
  })
  return json({ token, url: deps.env.LIVEKIT_URL, room: g.room, role: g.role, name: g.name, title: g.title })
}

/** One-to-one call: both people publish and subscribe; the database decides who may join and while the call can still be joined. */
async function callToken(deps: Deps, me: { id: string; token: string }, callId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return json({ error: 'Missing call.' }, 400)
  const gate = await asUser(deps, me.token).rpc('call_token_gate', { p_call: callId })
  if (!gate.ok) return json({ error: await dbError(gate, 'This call is not available.') }, gate.status === 401 ? 401 : 403)
  const g = (await gate.json()) as { room: string; kind: 'audio' | 'video'; name: string; role: 'caller' | 'callee' }
  if (g.role === 'caller') await roomService(deps, 'CreateRoom', { name: g.room, empty_timeout: 60, max_participants: 2 }, g.room).catch(() => null)
  const token = await signToken({
    apiKey: deps.env.LIVEKIT_API_KEY!, secret: deps.env.LIVEKIT_API_SECRET!, identity: me.id, name: g.name, ttlSec: 4 * 3600, now: deps.now?.(),
    metadata: JSON.stringify({ role: g.role }),
    video: { room: g.room, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true },
  })
  return json({ token, url: deps.env.LIVEKIT_URL, room: g.room, kind: g.kind, name: g.name })
}

/**
 * POST {stream_id, action, user_id?} — host moderation and the stage. The database decides; LiveKit applies it.
 *   end | ban                     host only (as before)
 *   guest_add | guest_remove      host puts someone on stage (camera + microphone only) or takes them off, live, no reconnect
 *   guest_leave                   a guest steps down themselves
 */
export async function handleLiveControl(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  if (need(deps.env, ...LK).length) return json({ error: 'Live streaming is not configured yet.' }, 503)
  const { stream_id, action, user_id } = (await req.json().catch(() => ({}))) as { stream_id?: string; action?: string; user_id?: string }
  if (!stream_id || !/^[0-9a-f-]{36}$/i.test(stream_id)) return json({ error: 'Missing stream.' }, 400)
  const user = asUser(deps, me.token)
  const stage = (identity: string, on: boolean, room: string) => roomService(deps, 'UpdateParticipant', { room, identity,
    permission: { can_subscribe: true, can_publish_data: true, can_publish: on, can_publish_sources: on ? ['CAMERA', 'MICROPHONE'] : [] } }, room).catch(() => null)
  if (action === 'guest_leave') {
    const r = await user.rpc('live_guest_leave', { sid: stream_id })
    if (!r.ok) return json({ error: await dbError(r, 'Could not leave the stage.') }, 400)
    const any = ((await (await user.rest(`/rest/v1/live_streams?id=eq.${stream_id}&select=room`)).json().catch(() => [])) as { room: string }[])[0]?.room
    if (any) await stage(me.id, false, any)
    return json({ ok: true })
  }
  const room = ((await (await user.rest(`/rest/v1/live_streams?id=eq.${stream_id}&host=eq.${me.id}&select=room`)).json().catch(() => [])) as { room: string }[])[0]?.room
  if (!room) return json({ error: 'Only the host can do that.' }, 403)

  if (action === 'end') {
    const r = await user.rpc('end_my_stream', { sid: stream_id })
    if (!r.ok) return json({ error: await dbError(r, 'Could not end the stream.') }, 400)
    await roomService(deps, 'DeleteRoom', { room }, room).catch(() => null)
    return json({ ok: true })
  }
  if ((action === 'guest_add' || action === 'guest_remove') && user_id && /^[0-9a-f-]{36}$/i.test(user_id)) {
    const on = action === 'guest_add'
    const r = await user.rpc('live_guest_set', { sid: stream_id, target: user_id, on_stage: on })
    if (!r.ok) return json({ error: await dbError(r, on ? 'Could not invite them on stage.' : 'Could not take them off stage.') }, 400)
    await stage(user_id, on, room)
    return json({ ok: true, guests: await r.json().catch(() => null) })
  }
  if (action === 'ban' && user_id && /^[0-9a-f-]{36}$/i.test(user_id)) {
    const r = await user.rpc('ban_from_stream', { sid: stream_id, target: user_id })
    if (!r.ok) return json({ error: await dbError(r, 'Could not remove that person.') }, 400)
    await roomService(deps, 'RemoveParticipant', { room, identity: user_id }, room).catch(() => null)
    return json({ ok: true })
  }
  return json({ error: 'Unknown action.' }, 400)
}

/** LiveKit → us. Authenticated by LiveKit's signed webhook token; updates stream state with the service role. */
export async function handleLiveWebhook(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return text('method not allowed', 405)
  if (need(deps.env, 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET').length) return text('not configured', 503)
  const body = await req.text()
  if (!(await verifyWebhook(req.headers.get('authorization'), body, deps.env.LIVEKIT_API_KEY!, deps.env.LIVEKIT_API_SECRET!, deps.now?.()))) return text('bad signature', 401)
  const ev = JSON.parse(body) as { event?: string; room?: { name?: string; numParticipants?: number; num_participants?: number } }
  const room = ev.room?.name
  if (!room || !ev.event) return text('ignored')
  const svc = service(deps)
  if (ev.event === 'room_started' || ev.event === 'room_finished') await svc.rpc('live_apply_event', { p_room: room, p_event: ev.event })
  if (ev.event === 'participant_joined' || ev.event === 'participant_left') {
    const n = ev.room?.numParticipants ?? ev.room?.num_participants
    if (typeof n === 'number') await svc.rpc('live_apply_event', { p_room: room, p_event: 'viewers', p_viewers: Math.max(0, n - 1) })   // minus the host
  }
  return text('OK')
}
