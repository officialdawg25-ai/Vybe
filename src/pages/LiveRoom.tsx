import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Flag, Gauge, Heart, Mic, MicOff, Send, Share2, SwitchCamera, Users, Video, VideoOff, Volume2, X } from 'lucide-react'
import type { Room as LkRoom, RemoteParticipant, LocalVideoTrack, RemoteVideoTrack } from 'livekit-client'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { MAX_CHAT, encodeMsg, getLiveToken, liveControl, parseMsg } from '../lib/streaming'
import { Empty, ErrorState, Spinner, errMsg, toast } from '../ui'
import { playSound } from '../lib/sounds'
import { ReportSheet } from '../components/Report'
import { useChromeless } from '../lib/chrome'
import { Avatar, Sheet } from '../ui'
import { getDataMode, readConditions } from '../lib/dataMode'
import { record } from '../lib/metrics'
import { PROFILES, captureSize, chooseProfile, readLiveStats, sizeLabel, type LivePref, type LiveStats, type ProfileId } from '../lib/liveQuality'

const PREF_KEY = 'vybe:live-quality'
const readPref = (): LivePref => { try { const v = localStorage.getItem(PREF_KEY) as LivePref | null; return v && (v === 'auto' || v in PROFILES) ? v : 'auto' } catch { return 'auto' } }
type Net = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

interface Row { id: string; host: string; title: string; status: string; access: string; event_id: string | null; profiles: { username: string; display_name: string; avatar_path?: string | null } }
interface Chat { id: number; from: string; name: string; text: string }

/** One component for both sides: /app/live/:id (watch) and /app/live/:id/host (broadcast). livekit-client loads only here. */
export default function LiveRoom({ host }: { host?: boolean }) {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const stream = useAsync(async () => {
    const { data, error } = await supabase.from('live_streams').select('id,host,title,status,access,event_id,profiles:host(username,display_name,avatar_path)').eq('id', id!).maybeSingle()
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
  useChromeless()
  const [floaters, setFloaters] = useState<number[]>([])
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
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
  const [pref, setPref] = useState<LivePref>(readPref)
  const [asked, setAsked] = useState<ProfileId | null>(null)          // the profile requested for this session
  const [net, setNet] = useState<Net>('unknown')
  const [needsTap, setNeedsTap] = useState(false)                     // the browser blocked sound until a tap
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null)
  const [reconnects, setReconnects] = useState(0)
  const [statsOpen, setStatsOpen] = useState(false)
  const [wide, setWide] = useState(false)                             // landscape stream: shown whole, not cropped
  const t0 = useRef(0)

  const attach = useCallback((track: { kind: string; attach: () => HTMLMediaElement }) => {
    const el = track.attach(); el.setAttribute('playsinline', ''); if (track.kind === 'video') { el.className = 'live-video'; el.setAttribute('aria-label', 'Live video') }
    // Time to first video frame, from pressing connect to a frame on screen (measured, per session).
    if (track.kind === 'video') { const shape = () => { const v = el as HTMLVideoElement; if (v.videoWidth && v.videoHeight) setWide(v.videoWidth > v.videoHeight) }; el.addEventListener('loadedmetadata', shape); el.addEventListener('resize', shape) }
    if (track.kind === 'video') el.addEventListener('playing', () => setFirstFrameMs(ms => { if (ms != null) return ms; const v = Math.round(performance.now() - t0.current); record('live_first_frame_ms', v); return v }), { once: true })
    video.current?.appendChild(el)
  }, [])

  const connect = useCallback(async () => {
    setPhase('connecting'); setErr(null); t0.current = performance.now(); setFirstFrameMs(null)
    try {
      const t = await getLiveToken(s.id, host)
      if (!t?.token || !t?.url) throw new Error('Live streaming isn’t available right now. Please try again shortly.')
      const lk = await import('livekit-client')                       // loaded only on this page
      // Broadcaster: ask for the chosen profile, publish it with smaller simulcast layers, and let LiveKit send each viewer
      // the layer that fits their screen and connection (adaptiveStream), pausing layers nobody needs (dynacast).
      const id = chooseProfile(pref, getDataMode(), readConditions()), P = PROFILES[id]
      const portrait = typeof matchMedia === 'function' && matchMedia('(orientation: portrait)').matches && navigator.maxTouchPoints > 0
      const r = new lk.Room({
        adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true,
        videoCaptureDefaults: { resolution: { ...captureSize(P, portrait), frameRate: P.fps }, facingMode: facing },
        publishDefaults: {
          simulcast: P.layers.length > 0,
          videoEncoding: { maxBitrate: P.maxBitrate, maxFramerate: P.fps },
          videoSimulcastLayers: P.layers.map(l => new lk.VideoPreset(PROFILES[l].width, PROFILES[l].height, PROFILES[l].maxBitrate, PROFILES[l].fps)),
          degradationPreference: 'balanced', red: true, dtx: true,
        },
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      if (host) setAsked(id)
      room.current = r
      const count = () => setViewers(Math.max(0, r.remoteParticipants.size + (host ? 0 : 0)))
      r.on(lk.RoomEvent.TrackSubscribed, (track) => attach(track as never))
      r.on(lk.RoomEvent.TrackUnsubscribed, (track) => (track as { detach: () => HTMLElement[] }).detach().forEach(e => e.remove()))
      r.on(lk.RoomEvent.ParticipantConnected, (p: RemoteParticipant) => { count(); if (p.identity === s.host) setHostOnline(true) })
      r.on(lk.RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => { count(); if (p.identity === s.host) setHostOnline(false) })
      r.on(lk.RoomEvent.Reconnecting, () => { setPhase('reconnecting'); setReconnects(k => k + 1); record('live_reconnect', 1) })
      r.on(lk.RoomEvent.Reconnected, () => setPhase('live'))
      r.on(lk.RoomEvent.ConnectionQualityChanged, (q, p) => { if (p.identity === r.localParticipant.identity) setNet(q as Net) })
      r.on(lk.RoomEvent.AudioPlaybackStatusChanged, () => setNeedsTap(!r.canPlaybackAudio))
      r.on(lk.RoomEvent.Disconnected, () => { if (room.current === r) { setPhase('idle'); setBroadcasting(false) } })
      r.on(lk.RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant) => {
        const m = parseMsg(payload); if (!m || !p) return
        if (m.t === 'react') { setHearts(h => h + 1); float() }
        else { setChat(c => [...c.slice(-199), { id: ++n.current, from: p.identity, name: p.name || 'Someone', text: m.m }]); if (host) playSound('comment') }
      })
      await r.connect(t.url, t.token)
      count(); setHostOnline(host || [...r.remoteParticipants.values()].some(p => p.identity === s.host))
      r.remoteParticipants.forEach(p => p.trackPublications.forEach(pub => { if (pub.track) attach(pub.track as never) }))
      setNeedsTap(!r.canPlaybackAudio)
      if (host) {
        try { await r.localParticipant.setCameraEnabled(true); await r.localParticipant.setMicrophoneEnabled(true) } catch (e) {
          const f = lk.MediaDeviceFailure.getFailure(e)
          await r.disconnect()
          throw new Error(f === lk.MediaDeviceFailure.PermissionDenied ? 'VYBE needs your camera and microphone to go live. Allow them in your browser’s site settings, then try again.'
            : f === lk.MediaDeviceFailure.NotFound ? 'No camera or microphone was found on this device.'
            : f === lk.MediaDeviceFailure.DeviceInUse ? 'Your camera or microphone is being used by another app. Close it, then try again.'
            : 'Your camera could not start. Try again, or restart the browser.')
        }
        const cam = [...r.localParticipant.trackPublications.values()].find(p => p.kind === 'video')?.track
        if (cam) attach(cam as never)
        setBroadcasting(true)
      }
      setPhase('live')
    } catch (e) {
      const message = errMsg(e)
      setErr({ message, needsTicket: /ticket/i.test(message) }); setPhase('error')
    }
  }, [s.id, s.host, host, attach, pref, facing])

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
  const react = async () => { if (!room.current) return; setHearts(h => h + 1); float(); playSound('like'); await room.current.localParticipant.publishData(encodeMsg({ t: 'react' }), { reliable: false }) }
  // Each heart floats up the right-hand side and disappears (kept to the last 12 so a burst stays light).
  function float() { const k = Date.now() + Math.random(); setFloaters(f => [...f.slice(-11), k]); setTimeout(() => setFloaters(f => f.filter(x => x !== k)), 2200) }
  const flip = async () => {
    const next = facing === 'user' ? 'environment' : 'user'
    const pub = [...(room.current?.localParticipant.trackPublications.values() ?? [])].find(p => p.kind === 'video')
    try { await (pub?.track as unknown as { restartTrack: (o: { facingMode: string }) => Promise<void> } | undefined)?.restartTrack({ facingMode: next }); setFacing(next) } catch { toast('Could not switch the camera.') }
  }
  const shareLive = async () => {
    const url = `${window.location.origin}/app/live/${s.id}`
    try { if (navigator.share) await navigator.share({ title: s.title, url }); else { await navigator.clipboard.writeText(url); toast('Link copied') } } catch { /* dismissed */ }
  }
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

  const who = s.profiles.display_name || s.profiles.username
  const status = phase === 'live' ? (host ? 'LIVE' : hostOnline ? 'LIVE' : 'Waiting for the host') : phase === 'reconnecting' ? 'Reconnecting…' : phase === 'connecting' ? 'Connecting…' : phase === 'error' ? 'Unavailable' : 'Offline'
  return (
    <div className={`lv${wide ? ' wide' : ''}`}>
      <h1 className="sr-only">{s.title} · {who}</h1>
      <div className={`lv-stage${host && facing === 'user' ? ' mirror' : ''}`} ref={video} aria-live="polite" />
      <div className="lv-shade" aria-hidden />

      <header className="lv-top">
        <Link to={`/app/u/${s.profiles.username}`} className="lv-host"><Avatar path={s.profiles.avatar_path ?? null} uid={s.host} name={who} /><span className="lv-host-text"><b className="clamp-1">{who}</b><span className="clamp-1">{s.title}{s.access === 'ticket' ? ' · Ticket holders' : ''}</span></span></Link>
        <span className={`lv-pill${phase === 'live' && (host || hostOnline) ? ' on' : ''}`} role="status">{phase === 'live' && (host || hostOnline) ? <><i aria-hidden /> {host ? 'You’re live' : 'LIVE'}</> : status}</span>
        {phase === 'live' && (net === 'poor' || net === 'lost') && <span className="lv-weak" role="status">Weak connection{host ? ' · lowering quality' : ''}</span>}
        <span className="lv-viewers" aria-label={`${viewers} watching`}><Users size={14} aria-hidden /> {viewers}</span>
        <button className="lv-close" aria-label={host ? 'Leave this screen' : 'Close'} onClick={() => nav(host ? '/app/live' : '/app')}><X size={22} /></button>
      </header>

      <div className="lv-center">
        {phase === 'live' && !host && !hostOnline && <p className="lv-msg">The host hasn’t started yet. This page will update when they do.</p>}
        {phase === 'connecting' && <div className="lv-msg"><Spinner /></div>}
        {phase === 'idle' && host && <div className="lv-msg"><p>Check your camera and microphone, then go live. Your friends and followers will be told.</p>
          <div className="lv-quality" role="radiogroup" aria-label="Video quality">
            {(['auto', 'fhd', 'hd', 'sd', 'low'] as LivePref[]).map(q => <button key={q} type="button" role="radio" aria-checked={pref === q} className="chip" onClick={() => { setPref(q); try { localStorage.setItem(PREF_KEY, q) } catch { /* not remembered */ } }}>{q === 'auto' ? `Auto (${PROFILES[chooseProfile('auto', getDataMode(), readConditions())].short})` : PROFILES[q].short}</button>)}
          </div>
          <p className="lv-fine">Full HD needs a camera and a connection that can keep up. VYBE lowers the quality by itself on a weak connection; Quality shows what is actually being sent.</p>
          <button className="btn primary lg" onClick={() => void connect()}>Go live</button></div>}
        {needsTap && phase === 'live' && <button className="btn lv-sound" onClick={() => void room.current?.startAudio().then(() => setNeedsTap(false))}><Volume2 size={18} aria-hidden /> Tap for sound</button>}
        {phase === 'idle' && !host && <div className="lv-msg"><p>You’re disconnected.</p><button className="btn" onClick={() => void connect()}>Reconnect</button></div>}
        {phase === 'error' && err && (
          <div className="lv-msg" role="alert"><p>{err.message}</p>
            {err.needsTicket && s.event_id ? <Link className="btn primary" to={`/app/plans/${s.event_id}`}>Get tickets</Link> : <button className="btn" onClick={() => void connect()}>Try again</button>}</div>
        )}
      </div>

      <div className="lv-hearts" aria-hidden>{floaters.map(k => <span key={k} style={{ ['--x' as string]: `${Math.round((k % 1) * 40 - 20)}px` }}>❤️</span>)}</div>

      <section aria-label="Live chat" className="lv-chat">
        <ul className="lv-log">{chat.slice(-8).map(c => (
          <li key={c.id}><b>{c.name}</b> {c.text}{host && c.from !== uid && <button className="lv-remove" onClick={() => void remove(c)}>Remove</button>}</li>))}
          {!chat.length && phase === 'live' && <li className="lv-hint">No messages yet. Say hello.</li>}</ul>
        <div className="lv-bar">
          <form className="lv-form" onSubmit={e => { e.preventDefault(); void send() }}>
            <input aria-label="Chat message" placeholder="Say something nice…" value={text} maxLength={MAX_CHAT} onChange={e => setText(e.target.value)} disabled={phase !== 'live'} />
            <button aria-label="Send message" disabled={phase !== 'live' || !text.trim()}><Send size={18} /></button>
          </form>
          {host && broadcasting ? <>
            <button className={`lv-btn${mic ? '' : ' off'}`} onClick={toggleMic} aria-pressed={!mic} aria-label={mic ? 'Mute microphone' : 'Unmute microphone'}>{mic ? <Mic size={20} /> : <MicOff size={20} />}</button>
            <button className={`lv-btn${cam ? '' : ' off'}`} onClick={toggleCam} aria-pressed={!cam} aria-label={cam ? 'Turn camera off' : 'Turn camera on'}>{cam ? <Video size={20} /> : <VideoOff size={20} />}</button>
            <button className="lv-btn" onClick={() => void flip()} aria-label="Switch camera"><SwitchCamera size={20} /></button>
            <button className="lv-btn" onClick={() => setStatsOpen(true)} aria-label="Stream quality"><Gauge size={20} /></button>
            <button className="lv-btn end" onClick={end} aria-label="End stream">End</button>
          </> : <>
            <button className="lv-btn heart" onClick={react} disabled={phase !== 'live'} aria-label="Send a heart"><Heart size={20} fill="currentColor" /></button>
            <button className="lv-btn" onClick={() => void shareLive()} aria-label="Share this stream"><Share2 size={20} /></button>
            {!host && <button className="lv-btn" onClick={() => setStatsOpen(true)} aria-label="Stream quality" disabled={phase !== 'live'}><Gauge size={18} /></button>}
            {!host && <button className="lv-btn" onClick={() => setReporting(true)} aria-label="Report this stream"><Flag size={18} /></button>}
          </>}
        </div>
        {hearts > 0 && <p className="lv-count" aria-live="polite">{hearts} {hearts === 1 ? 'heart' : 'hearts'}</p>}
      </section>
      {reporting && <ReportSheet target={{ type: 'stream', id: s.id }} onClose={() => setReporting(false)} />}
      {statsOpen && <QualitySheet room={room.current} host={host} hostId={s.host} asked={asked} net={net} firstFrameMs={firstFrameMs} reconnects={reconnects} onClose={() => setStatsOpen(false)} />}
    </div>
  )
}

/**
 * Stream quality, measured: refreshed every two seconds from WebRTC statistics while open. The broadcaster sees the profile
 * they asked for, the camera's real size and each simulcast layer as actually encoded; a viewer sees the size, frame rate and
 * bitrate they are actually receiving, with packet loss and jitter. Nothing here is an estimate.
 */
function QualitySheet({ room, host, hostId, asked, net, firstFrameMs, reconnects, onClose }: { room: LkRoom | null; host: boolean; hostId: string; asked: ProfileId | null; net: Net; firstFrameMs: number | null; reconnects: number; onClose: () => void }) {
  const [st, setSt] = useState<LiveStats | null>(null)
  useEffect(() => {
    let live = true, prev: Parameters<typeof readLiveStats>[2] = null
    const tick = async () => {
      if (!room) return
      const local = host ? ([...room.localParticipant.videoTrackPublications.values()][0]?.track as LocalVideoTrack | undefined) ?? null : null
      const remote = !host ? ([...(room.remoteParticipants.get(hostId)?.videoTrackPublications.values() ?? [])][0]?.track as RemoteVideoTrack | undefined) ?? null : null
      const { stats, sample } = await readLiveStats(local, remote, prev)
      prev = sample
      if (live) setSt(stats)
    }
    void tick(); const t = window.setInterval(() => void tick(), 2000)
    return () => { live = false; window.clearInterval(t) }
  }, [room, host, hostId])
  const rows: [string, string][] = [
    ...(host ? [['Requested', asked ? `${PROFILES[asked].label}, up to ${PROFILES[asked].fps} fps` : '—'] as [string, string], ['Camera', sizeLabel(st?.capture)] as [string, string]] : []),
    ...(host ? (st?.sent.length ? st.sent.map(l => [`Sending (${l.rid})`, l.paused ? 'paused: no viewer needs this size right now' : `${sizeLabel(l)} · ${l.fps} fps${l.kbps != null ? ` · ${l.kbps} kbps` : ''}${l.limitedBy ? ` · limited by ${l.limitedBy}` : ''}`] as [string, string]) : [['Sending', 'measuring…'] as [string, string]]) : []),
    ...(!host ? [['Receiving', st?.received ? `${sizeLabel(st.received)}${st.received.fps != null ? ` · ${st.received.fps} fps` : ''}${st.received.kbps != null ? ` · ${st.received.kbps} kbps` : ''}` : 'measuring…'] as [string, string],
      ['Packet loss', st?.received?.lossPct != null ? `${st.received.lossPct}%` : '—'] as [string, string], ['Jitter', st?.received?.jitterMs != null ? `${st.received.jitterMs} ms` : '—'] as [string, string]] : []),
    ['Connection', net === 'unknown' ? '—' : net[0].toUpperCase() + net.slice(1)],
    ...(st?.rttMs != null ? [['Round trip', `${st.rttMs} ms`] as [string, string]] : []),
    ['First video', firstFrameMs != null ? `${(firstFrameMs / 1000).toFixed(1)} s after connecting` : '—'],
    ['Reconnections', String(reconnects)],
  ]
  return (
    <Sheet title="Stream quality" onClose={onClose}>
      <dl className="lv-stats">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="t-meta" style={{ marginTop: 10 }}>Measured on this device every two seconds. Viewers each get the layer that suits their screen and connection.</p>
    </Sheet>
  )
}
