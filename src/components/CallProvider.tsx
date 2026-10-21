import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Lock, Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react'
import type { Room as LkRoom, RemoteParticipant } from 'livekit-client'
import { supabase } from '../lib/supabase'
import { callFunction } from '../lib/functions'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, errMsg, toast } from '../ui'
import { startRingtone } from '../lib/sounds'
import { peerPublicKey, useChatKeys } from '../lib/chatKeys'
import { labelledKey } from '../lib/e2ee'
import type { PublicProfile } from '../lib/types'

export interface CallRow { id: string; conversation_id: string; caller: string; callee: string; kind: 'audio' | 'video'; status: string; room: string; created_at: string; encrypted?: boolean }
interface Ctx { start: (conversationId: string, kind: 'audio' | 'video') => Promise<void>; inCall: boolean }
const CallCtx = createContext<Ctx>({ start: async () => {}, inCall: false })
export const useCalls = () => useContext(CallCtx)

const RING_MS = 60_000
const COLS = '*'
const fresh = (c: CallRow) => c.status === 'ringing' && Date.now() - new Date(c.created_at).getTime() < RING_MS

/** Owns call state for the whole app: incoming-call banner, the active call screen, and realtime updates. */
export function CallProvider({ children }: { children: ReactNode }) {
  const { uid } = useAuth()
  const keys = useChatKeys()
  const [incoming, setIncoming] = useState<{ call: CallRow; peer: PublicProfile | null } | null>(null)
  const [active, setActive] = useState<{ call: CallRow; peer: PublicProfile | null; e2eeKey?: string | null } | null>(null)
  const activeRef = useRef(active); activeRef.current = active

  const peerOf = useCallback(async (c: CallRow) => {
    const id = c.caller === uid ? c.callee : c.caller
    const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path,verified_until').eq('id', id).maybeSingle()
    return (data as PublicProfile | null) ?? null
  }, [uid])

  const ring = useCallback(async (c: CallRow) => {
    if (!fresh(c) || activeRef.current) return
    setIncoming({ call: c, peer: await peerOf(c) })
  }, [peerOf])

  useEffect(() => {
    if (!uid) return
    const load = async () => {
      const { data } = await supabase.from('calls').select(COLS).eq('callee', uid).eq('status', 'ringing').gt('created_at', new Date(Date.now() - RING_MS).toISOString()).order('created_at', { ascending: false }).limit(1)
      const c = (data as CallRow[] | null)?.[0]; if (c) void ring(c)
    }
    void load()
    const onRow = (c: CallRow) => {
      if (c.callee === uid && c.status === 'ringing') void ring(c)
      setIncoming(cur => (cur && cur.call.id === c.id && c.status !== 'ringing' ? null : cur))
      if (activeRef.current?.call.id === c.id && ['declined', 'ended', 'missed', 'cancelled'].includes(c.status)) { setActive(null); if (c.status === 'declined') toast('Call declined') }
    }
    const ch = supabase.channel(`calls:${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls', filter: `callee=eq.${uid}` }, p => onRow(p.new as CallRow))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `caller=eq.${uid}` }, p => onRow(p.new as CallRow))
      .subscribe()
    const vis = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', vis)
    return () => { document.removeEventListener('visibilitychange', vis); supabase.removeChannel(ch) }
  }, [uid, ring])

  // An unanswered incoming call stops ringing after a minute.
  useEffect(() => {
    if (!incoming) return
    const stop = startRingtone('incoming')
    const t = window.setTimeout(() => setIncoming(null), Math.max(1000, RING_MS - (Date.now() - new Date(incoming.call.created_at).getTime())))
    return () => { stop(); window.clearTimeout(t) }
  }, [incoming])

  /** Derives this call's end-to-end key from my private key and the other person's public key; null when either side cannot. */
  const callKey = useCallback(async (callId: string, peerId: string | undefined): Promise<string | null> => {
    if (!peerId || keys.state !== 'ready' || !keys.privateKey) return null
    const pub = await peerPublicKey(peerId).catch(() => null)
    return pub ? labelledKey(keys.privateKey, pub, `call:${callId}`) : null
  }, [keys.state, keys.privateKey])

  const start = useCallback(async (conversationId: string, kind: 'audio' | 'video') => {
    if (activeRef.current) return toast('You are already on a call')
    const { data: mem } = await supabase.from('conversation_members').select('profiles:user_id(id,username,display_name,avatar_path,verified_until)').eq('conversation_id', conversationId).neq('user_id', uid!).limit(1)
    const peer = ((mem as unknown as { profiles: PublicProfile }[] | null)?.[0]?.profiles) ?? null
    // Calls are end-to-end encrypted when both people have secure chat on and the browser supports it.
    const lk = await import('livekit-client')
    const wantE2ee = Boolean(peer && keys.state === 'ready' && lk.isE2EESupported() && await peerPublicKey(peer.id).catch(() => null))
    let res = await supabase.rpc('start_call', { p_conversation: conversationId, p_kind: kind, p_encrypted: wantE2ee })
    if (res.error && /start_call|function|schema cache/i.test(res.error.message) && !/on another call|blocked|Too many/i.test(res.error.message)) res = await supabase.rpc('start_call', { p_conversation: conversationId, p_kind: kind })   // database without migration 13
    if (res.error) return toast(errMsg(res.error))
    const c = res.data as { id: string; room: string; kind: 'audio' | 'video'; encrypted?: boolean }
    const call: CallRow = { id: c.id, conversation_id: conversationId, caller: uid!, callee: peer?.id ?? '', kind: c.kind, status: 'ringing', room: c.room, created_at: new Date().toISOString(), encrypted: Boolean(c.encrypted) }
    setActive({ call, peer, e2eeKey: call.encrypted ? await callKey(call.id, peer?.id) : null })
  }, [uid, keys.state, callKey])

  const accept = async () => {
    if (!incoming) return
    const { call, peer } = incoming
    let e2eeKey: string | null = null
    if (call.encrypted) {
      // An encrypted call can only be answered on a phone that holds the keys.
      const lk = await import('livekit-client')
      e2eeKey = lk.isE2EESupported() ? await callKey(call.id, call.caller) : null
      if (!e2eeKey) { toast('This call is end-to-end encrypted. Turn on secure chat on this device (open the chat) and ask them to call again.'); return decline() }
    }
    const { error } = await supabase.rpc('respond_call', { p_call: call.id, p_accept: true })
    if (error) { setIncoming(null); return toast(errMsg(error)) }
    setIncoming(null); setActive({ call: { ...call, status: 'active' }, peer, e2eeKey })
  }
  const decline = async () => {
    if (!incoming) return
    const id = incoming.call.id; setIncoming(null)
    await supabase.rpc('respond_call', { p_call: id, p_accept: false })
  }
  const hangUp = async () => {
    const id = activeRef.current?.call.id; setActive(null)
    if (id) await supabase.rpc('end_call', { p_call: id })
  }

  const value = useMemo(() => ({ start, inCall: Boolean(active) }), [start, active])
  return (
    <CallCtx.Provider value={value}>
      {children}
      {incoming && !active && (
        <div className="call-in" role="alertdialog" aria-label="Incoming call">
          <Link to={`/app/messages/${incoming.call.conversation_id}`} className="call-in-who"><Avatar size="lg" path={incoming.peer?.avatar_path} name={incoming.peer?.display_name || incoming.peer?.username || '?'} />
            <span><b>{incoming.peer?.display_name || incoming.peer?.username || 'Someone'}</b><small>{incoming.call.encrypted ? '🔒 ' : ''}Incoming {incoming.call.kind} call…</small></span></Link>
          <button className="call-btn decline" aria-label="Decline call" onClick={decline}><PhoneOff size={22} /></button>
          <button className="call-btn accept" aria-label="Answer call" onClick={accept}>{incoming.call.kind === 'video' ? <Video size={22} /> : <Phone size={22} />}</button>
        </div>
      )}
      {active && <CallScreen key={active.call.id} call={active.call} peer={active.peer} uid={uid!} e2eeKey={active.e2eeKey ?? null} onEnd={hangUp} />}
    </CallCtx.Provider>
  )
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function CallScreen({ call, peer, uid, e2eeKey, onEnd }: { call: CallRow; peer: PublicProfile | null; uid: string; e2eeKey: string | null; onEnd: () => void }) {
  const remote = useRef<HTMLDivElement>(null), local = useRef<HTMLDivElement>(null)
  const room = useRef<LkRoom | null>(null)
  const [phase, setPhase] = useState<'connecting' | 'ringing' | 'connected' | 'reconnecting' | 'error'>('connecting')
  const [err, setErr] = useState('')
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(call.kind === 'video')
  const [secs, setSecs] = useState(0)
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false)
  const isCaller = call.caller === uid
  const name = peer?.display_name || peer?.username || 'Call'

  useEffect(() => {
    let live = true
    const stopRing = isCaller ? startRingtone('outgoing') : () => {}
    ;(async () => {
      try {
        const t = await callFunction<{ token: string; url: string }>('livekit-token', { call_id: call.id })
        if (!t?.token || !t?.url) throw new Error('Calls are not set up yet.')
        const lk = await import('livekit-client')
        if (call.encrypted && !e2eeKey) throw new Error('This call is end-to-end encrypted, but this device does not hold the keys. Open the chat and turn on secure chat.')
        let e2ee: { keyProvider: InstanceType<typeof lk.ExternalE2EEKeyProvider>; worker: Worker } | undefined = undefined
        if (call.encrypted && e2eeKey) {
          const keyProvider = new lk.ExternalE2EEKeyProvider()
          await keyProvider.setKey(e2eeKey)
          e2ee = { keyProvider, worker: new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' }) }
        }
        const r = new lk.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, ...(e2ee ? { e2ee } : {}) })
        if (e2ee) await r.setE2EEEnabled(true)
        room.current = r
        const attach = (track: { kind: string; attach: () => HTMLMediaElement }) => {
          const el = track.attach(); el.setAttribute('playsinline', '')
          if (track.kind === 'video') { el.className = 'call-video'; setHasRemoteVideo(true) }
          remote.current?.appendChild(el)
        }
        r.on(lk.RoomEvent.TrackSubscribed, track => attach(track as never))
        r.on(lk.RoomEvent.TrackUnsubscribed, track => { (track as { detach: () => HTMLElement[] }).detach().forEach(e => e.remove()); if (track.kind === 'video') setHasRemoteVideo(false) })
        r.on(lk.RoomEvent.ParticipantConnected, () => { if (live) { setPhase('connected'); stopRing() } })
        r.on(lk.RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => { if (live) onEnd() })
        r.on(lk.RoomEvent.Reconnecting, () => setPhase('reconnecting'))
        r.on(lk.RoomEvent.Reconnected, () => setPhase('connected'))
        r.on(lk.RoomEvent.Disconnected, () => { if (live && room.current === r) onEnd() })
        await r.connect(t.url, t.token)
        if (!live) { void r.disconnect(); return }
        r.remoteParticipants.forEach(p => p.trackPublications.forEach(pub => { if (pub.track) attach(pub.track as never) }))
        await r.localParticipant.setMicrophoneEnabled(true)
        if (call.kind === 'video') {
          await r.localParticipant.setCameraEnabled(true)
          const camTrack = [...r.localParticipant.trackPublications.values()].find(p => p.kind === 'video')?.track
          if (camTrack && local.current) { const el = (camTrack as unknown as { attach: () => HTMLMediaElement }).attach(); el.className = 'call-self'; el.setAttribute('playsinline', ''); local.current.replaceChildren(el) }
        }
        setPhase(r.remoteParticipants.size ? 'connected' : 'ringing')
      } catch (e) {
        if (!live) return
        const m = errMsg(e); setErr(/configured|set up/i.test(m) ? 'Calls are not set up yet. Ask the VYBE team to finish the LiveKit setup.' : m); setPhase('error')
      }
    })()
    // Nobody picked up within a minute: stop calling.
    const giveUp = isCaller ? window.setTimeout(() => { if (live && !room.current?.remoteParticipants.size) { toast('No answer'); onEnd() } }, 62_000) : 0
    return () => { live = false; stopRing(); window.clearTimeout(giveUp); const r = room.current; room.current = null; void r?.disconnect(); remote.current?.replaceChildren() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (phase !== 'connected') return; const t = window.setInterval(() => setSecs(s => s + 1), 1000); return () => window.clearInterval(t) }, [phase])

  const toggleMic = async () => { await room.current?.localParticipant.setMicrophoneEnabled(!mic); setMic(m => !m) }
  const toggleCam = async () => {
    const r = room.current; if (!r) return
    await r.localParticipant.setCameraEnabled(!cam); setCam(c => !c)
    if (!cam) { const t = [...r.localParticipant.trackPublications.values()].find(p => p.kind === 'video')?.track; if (t && local.current) { const el = (t as unknown as { attach: () => HTMLMediaElement }).attach(); el.className = 'call-self'; local.current.replaceChildren(el) } }
  }
  const status = phase === 'connected' ? clock(secs) : phase === 'ringing' ? (isCaller ? 'Calling…' : 'Connecting…') : phase === 'reconnecting' ? 'Reconnecting…' : phase === 'error' ? err : 'Connecting…'

  return (
    <div className="call" role="dialog" aria-modal="true" aria-label={`Call with ${name}`}>
      <div ref={remote} className="call-remote" />
      {!hasRemoteVideo && (
        <div className="call-id"><Avatar size="lg" path={peer?.avatar_path} name={name} /><h2>{name}</h2><p role="status" aria-live="polite">{status}</p>{call.encrypted && <p className="call-lock"><Lock size={14} aria-hidden /> End-to-end encrypted</p>}</div>
      )}
      {hasRemoteVideo && <p className="call-chip" role="status">{call.encrypted && <Lock size={12} aria-hidden />} {name} · {status}</p>}
      {call.kind === 'video' && phase !== 'error' && <div ref={local} className={`call-local${cam ? '' : ' off'}`} aria-label="Your camera" />}
      <div className="call-bar">
        <button className={`call-btn${mic ? '' : ' off'}`} aria-pressed={!mic} aria-label={mic ? 'Mute microphone' : 'Unmute microphone'} onClick={toggleMic} disabled={phase === 'error'}>{mic ? <Mic size={24} /> : <MicOff size={24} />}</button>
        {call.kind === 'video' && <button className={`call-btn${cam ? '' : ' off'}`} aria-pressed={!cam} aria-label={cam ? 'Turn camera off' : 'Turn camera on'} onClick={toggleCam} disabled={phase === 'error'}>{cam ? <Video size={24} /> : <VideoOff size={24} />}</button>}
        <button className="call-btn decline" aria-label="End call" onClick={onEnd}><PhoneOff size={26} /></button>
      </div>
    </div>
  )
}
