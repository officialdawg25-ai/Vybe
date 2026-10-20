import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Heart, Mic, MicOff, Send, Users, Video, VideoOff } from 'lucide-react'
import type { Room as LkRoom, RemoteParticipant } from 'livekit-client'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { MAX_CHAT, encodeMsg, getLiveToken, liveControl, parseMsg } from '../lib/streaming'
import { Empty, ErrorState, Spinner, errMsg, toast } from '../ui'
import { playSound } from '../lib/sounds'
import { ReportSheet } from '../components/Report'

interface Row { id: string; host: string; title: string; status: string; access: string; event_id: string | null; profiles: { username: string; display_name: string } }
interface Chat { id: number; from: string; name: string; text: string }

/** One component for both sides: /app/live/:id (watch) and /app/live/:id/host (broadcast). livekit-client loads only here. */
export default function LiveRoom({ host }: { host?: boolean }) {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const stream = useAsync(async () => {
    const { data, error } = await supabase.from('live_streams').select('id,host,title,status,access,event_id,profiles:host(username,display_name)').eq('id', id!).maybeSingle()
    if (error) throw error
    return data as unknown as Row | null
  }, [id])
  useEffect(() => { document.title = `${stream.data?.title ?? 'Live'} · VYBE` }, [stream.data])

  if (stream.loading) return <Spinner />
  if (stream.error) return <ErrorState message={stream.error} onRetry={stream.reload} />
  const s = stream.data
  if (!s) return <Empty title="Stream not found" action={<Link className="btn" to="/app/live">Back to Live</Link>}>It may have ended, or you may not have access.</Empty>
  if (host && s.host !== uid) { nav(`/app/live/${s.id}`, { replace: true }); return null }
  if (s.status === 'ended' || s.status === 'cancelled') return <Empty title={s.status === 'ended' ? 'This stream has ended' : 'This stream was cancelled'} action={<Link className="btn" to="/app/live">Back to Live</Link>} />
  return <LiveStage s={s} host={Boolean(host)} />
}

function LiveStage({ s, host }: { s: Row; host: boolean }) {
  const { uid } = useAuth()
  const nav = useNavigate()
  const video = useRef<HTMLDivElement>(null)
  const room = useRef<LkRoom | null>(null)
  const last = useRef(0)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'>(host ? 'idle' : 'connecting')
  const [err, setErr] = useState<{ message: string; needsTicket?: boolean } | null>(null)
  const [viewers, setViewers] = useState(0)
  const [chat, setChat] = useState<Chat[]>([])
  const [text, setText] = useState('')
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  const [hearts, setHearts] = useState(0)
  const [broadcasting, setBroadcasting] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [hostOnline, setHostOnline] = useState(false)
  const n = useRef(0)

  const attach = useCallback((track: { kind: string; attach: () => HTMLMediaElement }) => {
    const el = track.attach(); el.setAttribute('playsinline', ''); if (track.kind === 'video') { el.className = 'live-video'; el.setAttribute('aria-label', 'Live video') }
    video.current?.appendChild(el)
  }, [])

  const connect = useCallback(async () => {
    setPhase('connecting'); setErr(null)
    try {
      const t = await getLiveToken(s.id, host)
      if (!t?.token || !t?.url) throw new Error('Live streaming isn’t available right now. Please try again shortly.')
      const lk = await import('livekit-client')                       // loaded only on this page
      const r = new lk.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true })
      room.current = r
      const count = () => setViewers(Math.max(0, r.remoteParticipants.size + (host ? 0 : 0)))
      r.on(lk.RoomEvent.TrackSubscribed, (track) => attach(track as never))
      r.on(lk.RoomEvent.TrackUnsubscribed, (track) => (track as { detach: () => HTMLElement[] }).detach().forEach(e => e.remove()))
      r.on(lk.RoomEvent.ParticipantConnected, (p: RemoteParticipant) => { count(); if (p.identity === s.host) setHostOnline(true) })
      r.on(lk.RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => { count(); if (p.identity === s.host) setHostOnline(false) })
      r.on(lk.RoomEvent.Reconnecting, () => setPhase('reconnecting'))
      r.on(lk.RoomEvent.Reconnected, () => setPhase('live'))
      r.on(lk.RoomEvent.Disconnected, () => { if (room.current === r) { setPhase('idle'); setBroadcasting(false) } })
      r.on(lk.RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant) => {
        const m = parseMsg(payload); if (!m || !p) return
        if (m.t === 'react') setHearts(h => h + 1)
        else { setChat(c => [...c.slice(-199), { id: ++n.current, from: p.identity, name: p.name || 'Someone', text: m.m }]); if (host) playSound('comment') }
      })
      await r.connect(t.url, t.token)
      count(); setHostOnline(host || [...r.remoteParticipants.values()].some(p => p.identity === s.host))
      r.remoteParticipants.forEach(p => p.trackPublications.forEach(pub => { if (pub.track) attach(pub.track as never) }))
      if (host) {
        await r.localParticipant.setCameraEnabled(true); await r.localParticipant.setMicrophoneEnabled(true)
        const cam = [...r.localParticipant.trackPublications.values()].find(p => p.kind === 'video')?.track
        if (cam) attach(cam as never)
        setBroadcasting(true)
      }
      setPhase('live')
    } catch (e) {
      const message = errMsg(e)
      setErr({ message, needsTicket: /ticket/i.test(message) }); setPhase('error')
    }
  }, [s.id, s.host, host, attach])

  useEffect(() => {
    if (!host) void connect()
    let lock: { release: () => Promise<void> } | null = null
    if (host && 'wakeLock' in navigator) (navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen').then(l => { lock = l }).catch(() => {})
    return () => { const r = room.current; room.current = null; void r?.disconnect(); void lock?.release(); video.current?.replaceChildren() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async () => {
    const m = text.trim().slice(0, MAX_CHAT)
    if (!m || !room.current || Date.now() - last.current < 1500) return          // one message every 1.5 s per person
    last.current = Date.now(); setText('')
    setChat(c => [...c.slice(-199), { id: ++n.current, from: uid!, name: 'You', text: m }])
    await room.current.localParticipant.publishData(encodeMsg({ t: 'chat', m }), { reliable: true })
  }
  const react = async () => { if (!room.current) return; setHearts(h => h + 1); playSound('like'); await room.current.localParticipant.publishData(encodeMsg({ t: 'react' }), { reliable: false }) }
  const toggleMic = async () => { await room.current?.localParticipant.setMicrophoneEnabled(!mic); setMic(m => !m) }
  const toggleCam = async () => { await room.current?.localParticipant.setCameraEnabled(!cam); setCam(c => !c) }
  const end = async () => {
    if (!confirm('End this stream for everyone?')) return
    try { await liveControl(s.id, 'end'); await room.current?.disconnect(); nav('/app/live', { replace: true }); toast('Stream ended') } catch (e) { toast(errMsg(e)) }
  }
  const remove = async (c: Chat) => {
    if (!host || c.from === uid || !confirm(`Remove ${c.name} from this stream?`)) return
    try { await liveControl(s.id, 'ban', c.from); toast(`${c.name} was removed`); setChat(x => x.filter(m => m.from !== c.from)) } catch (e) { toast(errMsg(e)) }
  }

  return (
    <div className="live-room">
      <div className="row between" style={{ marginBottom: 8 }}>
        <div><h1 className="t-title">{s.title}</h1><p className="t-meta">{s.profiles.display_name || s.profiles.username}{s.access === 'ticket' ? ' · Ticket holders' : ''}</p></div>
        <span className={`live-pill${phase === 'live' && (host || hostOnline) ? ' on' : ''}`} role="status">{phase === 'live' ? (host ? '● You’re live' : hostOnline ? '● Live' : 'Waiting for the host') : phase === 'reconnecting' ? 'Reconnecting…' : phase === 'connecting' ? 'Connecting…' : phase === 'error' ? 'Unavailable' : 'Offline'}</span>
      </div>

      <div className="live-stage" ref={video} aria-live="polite">
        {phase === 'live' && !host && !hostOnline && <p className="live-msg">The host hasn’t started yet. This page will update when they do.</p>}
        {phase === 'connecting' && <div className="live-msg"><Spinner /></div>}
        {phase === 'idle' && host && <div className="live-msg"><p>Check your camera and microphone, then go live.</p><button className="btn primary lg" onClick={() => void connect()}>Go live</button></div>}
        {phase === 'idle' && !host && <div className="live-msg"><p>You’re disconnected.</p><button className="btn" onClick={() => void connect()}>Reconnect</button></div>}
        {phase === 'error' && err && (
          <div className="live-msg" role="alert"><p>{err.message}</p>
            {err.needsTicket && s.event_id ? <Link className="btn primary" to={`/app/plans/${s.event_id}`}>Get tickets</Link> : <button className="btn" onClick={() => void connect()}>Try again</button>}</div>
        )}
      </div>

      <div className="row" style={{ margin: '8px 0', flexWrap: 'wrap' }}>
        <span className="t-meta row" style={{ gap: 4 }}><Users size={14} aria-hidden /> {viewers} watching</span>
        <div className="grow" />
        {host && broadcasting && <>
          <button className="btn sm" onClick={toggleMic} aria-pressed={!mic}>{mic ? <Mic size={16} aria-hidden /> : <MicOff size={16} aria-hidden />} {mic ? 'Mute' : 'Unmute'}</button>
          <button className="btn sm" onClick={toggleCam} aria-pressed={!cam}>{cam ? <Video size={16} aria-hidden /> : <VideoOff size={16} aria-hidden />} {cam ? 'Camera off' : 'Camera on'}</button>
          <button className="btn sm danger" onClick={end}>End stream</button>
        </>}
        {!host && phase === 'live' && <><button className="btn sm" onClick={react} aria-label="Send a heart"><Heart size={16} aria-hidden /> {hearts || ''}</button><button className="btn ghost sm" onClick={() => setReporting(true)}>Report</button></>}
        {host && hearts > 0 && <span className="t-meta"><Heart size={14} aria-hidden /> {hearts}</span>}
      </div>

      <section aria-label="Live chat" className="live-chat">
        <ul className="live-log" aria-live="polite">{chat.map(c => (
          <li key={c.id}><b>{c.name}</b> {c.text}{host && c.from !== uid && <button className="linklike t-meta" style={{ marginLeft: 8 }} onClick={() => void remove(c)}>Remove</button>}</li>))}
          {!chat.length && <li className="t-meta">No messages yet. Say hello.</li>}</ul>
        <form className="row" onSubmit={e => { e.preventDefault(); void send() }}>
          <input className="input" aria-label="Chat message" placeholder="Say something nice" value={text} maxLength={MAX_CHAT} onChange={e => setText(e.target.value)} disabled={phase !== 'live'} />
          <button className="btn primary" disabled={phase !== 'live' || !text.trim()} aria-label="Send message"><Send size={18} aria-hidden /></button>
        </form>
      </section>
      {reporting && <ReportSheet target={{ type: 'stream', id: s.id }} onClose={() => setReporting(false)} />}
    </div>
  )
}
