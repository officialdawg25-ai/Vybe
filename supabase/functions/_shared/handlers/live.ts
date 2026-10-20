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
  const { stream_id, publish } = (await req.json().catch(() => ({}))) as { stream_id?: string; publish?: boolean }
  if (!stream_id || !/^[0-9a-f-]{36}$/i.test(stream_id)) return json({ error: 'Missing stream.' }, 400)

  const gate = await asUser(deps, me.token).rpc('live_token_gate', { sid: stream_id, want_publish: Boolean(publish) })
  if (!gate.ok) return json({ error: await dbError(gate, 'This stream is not available.') }, gate.status === 401 ? 401 : 403)
  const g = (await gate.json()) as { room: string; role: 'host' | 'viewer'; name: string; title: string; status: string }

  if (g.role === 'host') {   // the room is created up front with a ceiling on viewers and an auto-close when empty
    const max = Number(deps.env.LIVE_MAX_VIEWERS ?? 2000)
    await roomService(deps, 'CreateRoom', { name: g.room, empty_timeout: 300, max_participants: max + 1 }, g.room).catch(() => null)
  }
  const token = await signToken({
    apiKey: deps.env.LIVEKIT_API_KEY!, secret: deps.env.LIVEKIT_API_SECRET!, identity: me.id, name: g.name, ttlSec: g.role === 'host' ? 6 * 3600 : 2 * 3600, now: deps.now?.(),
    metadata: JSON.stringify({ role: g.role }),
    video: { room: g.room, roomJoin: true, canSubscribe: true, canPublish: g.role === 'host', canPublishData: true },
  })
  return json({ token, url: deps.env.LIVEKIT_URL, room: g.room, role: g.role, name: g.name, title: g.title })
}

/** POST {stream_id, action: 'end' | 'ban', user_id?} — host moderation. The database checks the host; LiveKit does the removal. */
export async function handleLiveControl(req: Request, deps: Deps): Promise<Response> {
  const pf = preflight(req); if (pf) return pf
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const me = await whoami(deps, req)
  if (!me) return json({ error: 'Sign in again to continue.' }, 401)
  if (need(deps.env, ...LK).length) return json({ error: 'Live streaming is not configured yet.' }, 503)
  const { stream_id, action, user_id } = (await req.json().catch(() => ({}))) as { stream_id?: string; action?: string; user_id?: string }
  if (!stream_id || !/^[0-9a-f-]{36}$/i.test(stream_id)) return json({ error: 'Missing stream.' }, 400)
  const user = asUser(deps, me.token)
  const room = ((await (await user.rest(`/rest/v1/live_streams?id=eq.${stream_id}&host=eq.${me.id}&select=room`)).json().catch(() => [])) as { room: string }[])[0]?.room
  if (!room) return json({ error: 'Only the host can do that.' }, 403)

  if (action === 'end') {
    const r = await user.rpc('end_my_stream', { sid: stream_id })
    if (!r.ok) return json({ error: await dbError(r, 'Could not end the stream.') }, 400)
    await roomService(deps, 'DeleteRoom', { room }, room).catch(() => null)
    return json({ ok: true })
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
