import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  BarChart3, Eye, EyeOff, Flag, Gauge, Heart, LogOut, MessageCircle, Mic, MicOff, Pin, PinOff, Send, Share2, SwitchCamera,
  UserPlus, Users, Video, VideoOff, Volume2, VolumeX, X,
} from 'lucide-react'
import type { Room as LkRoom, RemoteParticipant, LocalVideoTrack, RemoteVideoTrack, Participant, Track } from 'livekit-client'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { MAX_CHAT, MAX_POLL_OPT, MAX_POLL_Q, REACTIONS, encodeMsg, getLiveToken, liveControl, parseMsg, tallyVotes, type LiveMsg, type Reaction } from '../lib/streaming'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast } from '../ui'
import { playSound } from '../lib/sounds'
import { ReportSheet } from '../components/Report'
import { FollowButton } from '../components/discover/FollowButton'
import { useChromeless } from '../lib/chrome'
import { getDataMode, readConditions } from '../lib/dataMode'
import { record } from '../lib/metrics'
import { PROFILES, captureSize, chooseProfile, readLiveStats, sizeLabel, type LivePref, type LiveStats, type ProfileId } from '../lib/liveQuality'

const PREF_KEY = 'vybe:live-quality'
const readPref = (): LivePref => { try { const v = localStorage.getItem(PREF_KEY) as LivePref | null; return v && (v === 'auto' || v in PROFILES) ? v : 'auto' } catch { return 'auto' } }
type Net = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'
const MAX_GUESTS = 3
const TOPIC = 'vybe-live'

interface Row { id: string; host: string; title: string; status: string; access: string; event_id: string | null; started_at: string | null; profiles: { username: string; display_name: string; avatar_path?: string | null } }
interface Chat { id: number; from: string; name: string; text: string }
interface TileInfo { id: string; name: string; local: boolean; isHost: boolean; video: Track | null; micOn: boolean }
interface Poll { id: string; q: string; o: string[]; c: number[]; open: boolean }

/** One component for both sides: /app/live/:id (watch) and /app/live/:id/host (broadcast). livekit-client loads only here. */
export default function LiveRoom({ host }: { host?: boolean }) {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const stream = useAsync(async () => {
    let r = await supabase.from('live_streams').select('id,host,title,status,access,event_id,started_at,profiles:host(username,display_name,avatar_path)').eq('id', id!).maybeSingle()
    if (r.error) r = await supabase.from('live_streams').select('id,host,title,status,access,event_id,profiles:host(username,display_name,avatar_path)').eq('id', id!).maybeSingle()
    if (r.error) throw r.error
    return r.data ? ({ started_at: null, ...(r.data as object) } as unknown as Row) : null
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

const pollId = () => Math.random().toString(36).slice(2, 10)
const fmtClock = (ms: number) => { const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}` }

/**
 * The live screen, full window on every device (the app's navigation steps aside). Up to four people on stage: the host plus
 * up to three guests the host invites from viewers' requests (camera and microphone only; the database decides who may send).
 * Text comments only (no voice or video notes on a live), emoji reactions, the host's pinned comment, live polls, and a clean
 * view that hides everything but the video (tap the video; double-tap sends a heart).
 */
function LiveStage({ s, host }: { s: Row; host: boolean }) {
  const { uid } = useAuth()
  useChromeless()
  const nav = useNavigate()
  const room = useRef<LkRoom | null>(null)
  const audioBox = useRef<HTMLDivElement>(null)
  const last = useRef(0)
  const n = useRef(0)
  const t0 = useRef(0)
  const lastTap = useRef(0)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'>(host ? 'idle' : 'connecting')
  const [err, setErr] = useState<{ message: string; needsTicket?: boolean } | null>(null)
  const [tiles, setTiles] = useState<TileInfo[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())       // identity -> display name, from LiveKit
  const [viewers, setViewers] = useState(0)
  const [chat, setChat] = useState<Chat[]>([])
  const [text, setText] = useState('')
  const [mic, setMic] = useState(true)
  const [cam, setCam] = useState(true)
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const [floaters, setFloaters] = useState<{ k: number; e: string }[]>([])
  const [reactions, setReactions] = useState(0)
  const [tray, setTray] = useState(false)
  const [clean, setClean] = useState(false)
  const [chatOn, setChatOn] = useState(true)
  const [quiet, setQuiet] = useState(false)                           // viewer muted the stream's sound
  const [reporting, setReporting] = useState(false)
  const [hostOnline, setHostOnline] = useState(false)
  const [pref, setPref] = useState<LivePref>(readPref)
  const [asked, setAsked] = useState<ProfileId | null>(null)
  const [net, setNet] = useState<Net>('unknown')
  const [needsTap, setNeedsTap] = useState(false)
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null)
  const [reconnects, setReconnects] = useState(0)
  const [statsOpen, setStatsOpen] = useState(false)
  const [wide, setWide] = useState(false)
  const [now, setNow] = useState(Date.now())
  // Stage (guests)
  const [stage, setStage] = useState<'off' | 'requested' | 'on'>('off')
  const [requests, setRequests] = useState<Map<string, string>>(new Map())       // host: identity -> name
  const [guestsOpen, setGuestsOpen] = useState(false)
  // Pinned comment and polls
  const [pinned, setPinned] = useState<{ m: string; n: string; from?: string } | null>(null)
  const [poll, setPoll] = useState<Poll | null>(null)
  const [myVote, setMyVote] = useState<number | null>(null)
  const [pollOpen, setPollOpen] = useState(false)
  const votes = useRef(new Map<string, number>())
  const state = useRef({ pinned, poll }); state.current = { pinned, poll }
  const following = useAsync(async () => {
    if (host || !uid) return false
    const { data } = await supabase.from('follows').select('follower').eq('follower', uid).eq('target_type', 'profile').eq('target_id', s.host).maybeSingle()
    return Boolean(data)
  }, [s.host, uid, host])

  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [])

  const publishing = host || stage === 'on'
  // Messages go as LiveKit text streams on one topic: the server stamps each with the sender's identity (plain data packets
  // from viewers who do not publish media arrived without it, so their comments could not be attributed and were dropped).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const send = useCallback((m: LiveMsg, to?: string[], _reliable = true) => room.current?.localParticipant.sendText(new TextDecoder().decode(encodeMsg(m)), { topic: TOPIC, ...(to ? { destinationIdentities: to } : {}) }).catch(e => console.warn('live message not sent', m.t, e)), [])

  // Who is on stage: the host first, then guests sending camera; each tile shows its own video, name and mic state.
  const refresh = useCallback(() => {
    const r = room.current; if (!r) return
    const all: Participant[] = [r.localParticipant, ...r.remoteParticipants.values()]
    const out: TileInfo[] = []
    for (const p of all) {
      const isHost = p.identity === s.host
      const camPub = [...p.videoTrackPublications.values()].find(x => x.source === 'camera')
      const micPub = [...p.audioTrackPublications.values()].find(x => x.source === 'microphone')
      const video = camPub && !camPub.isMuted ? camPub.track ?? null : null
      if (!isHost && !camPub && !micPub) continue
      out.push({ id: p.identity, name: p.identity === uid ? 'You' : p.name || 'Guest', local: p === r.localParticipant, isHost, video, micOn: Boolean(micPub && !micPub.isMuted) })
    }
    out.sort((a, b) => Number(b.isHost) - Number(a.isHost))
    setTiles(out.slice(0, 1 + MAX_GUESTS))
    setViewers(r.remoteParticipants.size)
    setNames(new Map([...r.remoteParticipants.values()].filter(p => p.name).map(p => [p.identity, p.name!])))
  }, [s.host, uid])

  const enableMedia = useCallback(async (lk: typeof import('livekit-client'), r: LkRoom) => {
    try { await r.localParticipant.setCameraEnabled(true); await r.localParticipant.setMicrophoneEnabled(true); setCam(true); setMic(true) } catch (e) {
      const f = lk.MediaDeviceFailure.getFailure(e)
      throw new Error(f === lk.MediaDeviceFailure.PermissionDenied ? 'VYBE needs your camera and microphone to go live. Allow them in your browser’s site settings, then try again.'
        : f === lk.MediaDeviceFailure.NotFound ? 'No camera or microphone was found on this device.'
        : f === lk.MediaDeviceFailure.DeviceInUse ? 'Your camera or microphone is being used by another app. Close it, then try again.'
        : 'Your camera could not start. Try again, or restart the browser.')
    }
  }, [])

  function float(e: string) { const k = Date.now() + Math.random(); setReactions(x => x + 1); setFloaters(f => [...f.slice(-14), { k, e }]); setTimeout(() => setFloaters(f => f.filter(x => x.k !== k)), 2400) }

  const connect = useCallback(async () => {
    setPhase('connecting'); setErr(null); t0.current = performance.now(); setFirstFrameMs(null)
    try {
      const t = await getLiveToken(s.id, host)
      if (!t?.token || !t?.url) throw new Error('Live streaming isn’t available right now. Please try again shortly.')
      const lk = await import('livekit-client')                       // loaded only on this page
      // Broadcaster: ask for the chosen profile, publish it with smaller simulcast layers, and let LiveKit send each viewer the
      // layer that fits their screen and connection (adaptiveStream), pausing layers nobody needs (dynacast). Guests send HD at most.
      const id = host ? chooseProfile(pref, getDataMode(), readConditions()) : chooseProfile('auto', getDataMode(), readConditions()) === 'fhd' ? 'hd' : chooseProfile('auto', getDataMode(), readConditions())
      const P = PROFILES[id]
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
      setAsked(id)
      room.current = r
      const E = lk.RoomEvent
      for (const ev of [E.TrackPublished, E.TrackUnpublished, E.TrackMuted, E.TrackUnmuted, E.LocalTrackPublished, E.LocalTrackUnpublished, E.ParticipantNameChanged]) r.on(ev, refresh)
      r.on(E.TrackSubscribed, (track: Track) => {
        if (track.kind === 'audio') { const el = track.attach(); el.dataset.lv = '1'; audioBox.current?.appendChild(el) }
        refresh()
      })
      r.on(E.TrackUnsubscribed, (track: Track) => { if (track.kind === 'audio') track.detach().forEach(e => e.remove()); refresh() })
      r.on(E.ParticipantConnected, (p: RemoteParticipant) => {
        refresh(); if (p.identity === s.host) setHostOnline(true)
        // Late joiners get the host's current pin and poll.
        if (host) { const st = state.current; if (st.pinned) void send({ t: 'pin', m: st.pinned.m, n: st.pinned.n, ...(st.pinned.from ? { f: st.pinned.from } : {}) }, [p.identity]); if (st.poll) { void send({ t: 'poll', id: st.poll.id, q: st.poll.q, o: st.poll.o }, [p.identity]); void send({ t: 'tally', id: st.poll.id, c: st.poll.c }, [p.identity]); if (!st.poll.open) void send({ t: 'poll_end', id: st.poll.id }, [p.identity]) } }
      })
      r.on(E.ParticipantDisconnected, (p: RemoteParticipant) => { refresh(); if (p.identity === s.host) setHostOnline(false); setRequests(q => { if (!q.has(p.identity)) return q; const x = new Map(q); x.delete(p.identity); return x }) })
      r.on(E.Reconnecting, () => { setPhase('reconnecting'); setReconnects(k => k + 1); record('live_reconnect', 1) })
      r.on(E.Reconnected, () => setPhase('live'))
      r.on(E.ConnectionQualityChanged, (q, p) => { if (p.identity === r.localParticipant.identity) setNet(q as Net) })
      r.on(E.AudioPlaybackStatusChanged, () => setNeedsTap(!r.canPlaybackAudio))
      r.on(E.Disconnected, () => { if (room.current === r) { setPhase('idle'); setStage('off') } })
      // The host put me on stage (or took me off): the server changed my permissions; start or stop my camera and microphone.
      r.on(E.ParticipantPermissionsChanged, (_prev, p) => {
        if (host || (p && p.identity !== r.localParticipant.identity)) return
        if (r.localParticipant.permissions?.canPublish) {
          setStage('on'); toast('You’re on stage. Your camera and microphone are on.'); playSound('success')
          void enableMedia(lk, r).catch(e => { toast(errMsg(e)); void liveControl(s.id, 'guest_leave').catch(() => {}) })
        } else { setStage(st => { if (st === 'on') toast('You’re off stage.'); return 'off' }); setCam(true); setMic(true) }
        refresh()
      })
      r.registerTextStreamHandler(TOPIC, async (reader, info) => {
        const raw = await reader.readAll().catch(() => '')
        if (raw.length > 4000) return
        const m = parseMsg(new TextEncoder().encode(raw)); if (!m) return
        const p = { identity: info.identity, name: r.remoteParticipants.get(info.identity)?.name || undefined }
        const fromHost = p.identity === s.host
        switch (m.t) {
          case 'chat': setChat(c => [...c.slice(-199), { id: ++n.current, from: p.identity, name: p.name || 'Someone', text: m.m }]); if (host) playSound('comment'); break
          case 'react': float(m.e); break
          case 'join': if (host) { setRequests(q => new Map(q).set(p.identity, p.name || 'Someone')); playSound('notify') } break
          case 'join_cancel': if (host) setRequests(q => { const x = new Map(q); x.delete(p.identity); return x }); break
          case 'pin': if (fromHost) setPinned({ m: m.m, n: m.n, from: m.f }); break
          case 'unpin': if (fromHost) setPinned(null); break
          case 'poll': if (fromHost) { setPoll({ id: m.id, q: m.q, o: m.o, c: m.o.map(() => 0), open: true }); setMyVote(null) } break
          case 'tally': if (fromHost) setPoll(x => (x && x.id === m.id && m.c.length === x.o.length ? { ...x, c: m.c } : x)); break
          case 'poll_end': if (fromHost) setPoll(x => (x && x.id === m.id ? { ...x, open: false } : x)); break
          case 'vote': if (host) { const cur = state.current.poll; if (cur && cur.open && cur.id === m.id && m.i < cur.o.length) { votes.current.set(p.identity, m.i); setPoll({ ...cur, c: tallyVotes(votes.current, cur.o.length) }) } } break
        }
      })
      await r.connect(t.url, t.token)
      setHostOnline(host || [...r.remoteParticipants.values()].some(p => p.identity === s.host))
      r.remoteParticipants.forEach(p => p.audioTrackPublications.forEach(pub => { if (pub.track) { const el = pub.track.attach(); audioBox.current?.appendChild(el) } }))
      setNeedsTap(!r.canPlaybackAudio)
      if (host) { try { await enableMedia(lk, r) } catch (e) { await r.disconnect(); throw e } }
      if (!host && t.role === 'guest') { setStage('on'); await enableMedia(lk, r).catch(e => toast(errMsg(e))) }
      refresh()
      setPhase('live')
    } catch (e) {
      const message = errMsg(e)
      setErr({ message, needsTicket: /ticket/i.test(message) }); setPhase('error')
    }
  }, [s.id, s.host, host, pref, facing, refresh, enableMedia, send])

  useEffect(() => {
    if (!host) void connect()
    let lock: { release: () => Promise<void> } | null = null
    if ('wakeLock' in navigator) (navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen').then(l => { lock = l }).catch(() => {})
    return () => { const r = room.current; room.current = null; void r?.disconnect(); void lock?.release(); audioBox.current?.replaceChildren() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Host: publish the poll tally at most once a second while votes come in.
  const sentTally = useRef('')
  useEffect(() => {
    if (!host || !poll) return
    const t = window.setTimeout(() => { const k = `${poll.id}:${poll.c.join(',')}`; if (k !== sentTally.current) { sentTally.current = k; void send({ t: 'tally', id: poll.id, c: poll.c }) } }, 1000)
    return () => window.clearTimeout(t)
  }, [host, poll, send])

  // Viewer sound on/off (the stream keeps playing).
  useEffect(() => { audioBox.current?.querySelectorAll('audio').forEach(a => { a.muted = quiet }) }, [quiet, tiles])

  const sendChat = async () => {
    const m = text.trim().slice(0, MAX_CHAT)
    if (!m || !room.current || Date.now() - last.current < 1500) return          // one message every 1.5 s per person
    last.current = Date.now(); setText('')
    setChat(c => [...c.slice(-199), { id: ++n.current, from: uid!, name: 'You', text: m }])
    await send({ t: 'chat', m })
  }
  const react = (e: Reaction = '❤️') => { if (!room.current) return; float(e); playSound('like'); void send({ t: 'react', e }, undefined, false) }
  const flip = async () => {
    const next = facing === 'user' ? 'environment' : 'user'
    const pub = [...(room.current?.localParticipant.videoTrackPublications.values() ?? [])][0]
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
  const pin = (c: Chat | null) => {
    if (!host) return
    if (!c) { setPinned(null); void send({ t: 'unpin' }); return }
    const p = { m: c.text, n: c.from === uid ? 'Host' : names.get(c.from) || room.current?.remoteParticipants.get(c.from)?.name || c.name }
    setPinned({ ...p, from: c.from }); void send({ t: 'pin', ...p, f: c.from })
  }
  // Stage requests (viewer) and decisions (host).
  const requestStage = () => { if (stage === 'off') { void send({ t: 'join' }, [s.host]); setStage('requested'); toast('Request sent. The host will see it.') } else if (stage === 'requested') { void send({ t: 'join_cancel' }, [s.host]); setStage('off') } }
  const leaveStage = async () => { try { await room.current?.localParticipant.setCameraEnabled(false); await room.current?.localParticipant.setMicrophoneEnabled(false); await liveControl(s.id, 'guest_leave'); setStage('off') } catch (e) { toast(errMsg(e)) } }
  const guests = tiles.filter(t => !t.isHost)
  const decide = async (identity: string, accept: boolean) => {
    setRequests(q => { const x = new Map(q); x.delete(identity); return x })
    if (!accept) return
    try { await liveControl(s.id, 'guest_add', identity) } catch (e) { toast(errMsg(e)) }
  }
  const unstage = async (identity: string) => { try { await liveControl(s.id, 'guest_remove', identity) } catch (e) { toast(errMsg(e)) } }
  // Polls (host creates; everyone votes once, can change their vote while it is open).
  const startPoll = (q: string, o: string[]) => { const p: Poll = { id: pollId(), q, o, c: o.map(() => 0), open: true }; votes.current = new Map(); setPoll(p); setPollOpen(false); void send({ t: 'poll', id: p.id, q, o }) }
  const endPoll = () => { if (!poll) return; setPoll({ ...poll, open: false }); void send({ t: 'tally', id: poll.id, c: poll.c }); void send({ t: 'poll_end', id: poll.id }) }
  const vote = (i: number) => { if (!poll || !poll.open || host) return; setMyVote(i); void send({ t: 'vote', id: poll.id, i }, [s.host]) }
  // Tap the video: clean view on/off. Double-tap: a heart.
  const tapStage = () => {
    const t = Date.now()
    if (t - lastTap.current < 300) { lastTap.current = 0; react('❤️'); return }
    lastTap.current = t
    window.setTimeout(() => { if (lastTap.current === t) setClean(c => !c) }, 300)
  }

  const who = s.profiles.display_name || s.profiles.username
  const isLive = phase === 'live' && (host || hostOnline)
  const status = phase === 'live' ? (host ? 'LIVE' : hostOnline ? 'LIVE' : 'Waiting for the host') : phase === 'reconnecting' ? 'Reconnecting…' : phase === 'connecting' ? 'Connecting…' : phase === 'error' ? 'Unavailable' : 'Offline'
  const elapsed = s.started_at ? fmtClock(now - Date.parse(s.started_at)) : null
  const layout = `n${Math.min(4, Math.max(1, tiles.length))}`
  const totalVotes = poll ? poll.c.reduce((a, b) => a + b, 0) : 0

  return (
    <div className={`lv${wide ? ' wide' : ''}${clean ? ' clean' : ''}`}>
      <h1 className="sr-only">{s.title} · {who}</h1>
      <div className={`lv-grid ${layout}`} onClick={tapStage} role="presentation">
        {tiles.map(t => <StageTile key={t.id} t={t} solo={tiles.length === 1} mirror={t.local && facing === 'user'} onShape={setWide} onFirstFrame={() => setFirstFrameMs(ms => { if (ms != null) return ms; const v = Math.round(performance.now() - t0.current); record('live_first_frame_ms', v); return v })} />)}
      </div>
      <div ref={audioBox} hidden />
      <div className="lv-shade" aria-hidden />

      <header className="lv-top">
        <div className="lv-host">
          <Link to={`/app/u/${s.profiles.username}`} className="lv-host-link"><Avatar path={s.profiles.avatar_path ?? null} uid={s.host} name={who} /><span className="lv-host-text"><b className="clamp-1">{who}</b><span className="clamp-1">{s.title}{s.access === 'ticket' ? ' · Ticket holders' : ''}</span></span></Link>
          {!host && <FollowButton type="profile" id={s.host} following={Boolean(following.data)} onChange={() => following.reload()} label={who} className="lv-follow" />}
        </div>
        <span className={`lv-pill${isLive ? ' on' : ''}`} role="status">{isLive ? <><i aria-hidden /> LIVE{elapsed ? ` ${elapsed}` : ''}</> : status}</span>
        <span className="lv-viewers" aria-label={`${viewers} watching`}><Users size={14} aria-hidden /> {viewers}</span>
        <button className="lv-close" aria-label={host ? 'Leave this screen' : 'Close'} onClick={() => nav(host ? '/app/live' : '/app')}><X size={22} /></button>
      </header>
      {phase === 'live' && (net === 'poor' || net === 'lost') && <p className="lv-weak" role="status">Weak connection{publishing ? ' · lowering quality' : ''}</p>}
      {clean && <button className="lv-unclean" onClick={() => setClean(false)} aria-label="Show controls"><Eye size={18} /></button>}

      {poll && (
        <section className="lv-poll" aria-label="Live poll">
          <b className="lv-poll-q">{poll.q}</b>
          {poll.o.map((o, i) => {
            const pct = totalVotes ? Math.round((poll.c[i] / totalVotes) * 100) : 0
            return (
              <button key={i} className={`lv-poll-opt${myVote === i ? ' mine' : ''}`} disabled={host || !poll.open} aria-pressed={myVote === i} onClick={() => vote(i)}>
                <i style={{ width: `${pct}%` }} aria-hidden /><span>{o}</span><span>{pct}%</span>
              </button>
            )
          })}
          <span className="lv-poll-meta">{totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}{poll.open ? '' : ' · closed'}{host && poll.open && <button className="linklike" onClick={endPoll}>End poll</button>}{host && !poll.open && <button className="linklike" onClick={() => setPoll(null)}>Hide</button>}</span>
        </section>
      )}

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

      <div className="lv-hearts" aria-hidden>{floaters.map(f => <span key={f.k} style={{ ['--x' as string]: `${Math.round((f.k % 1) * 40 - 20)}px` }}>{f.e}</span>)}</div>

      {/* The action rail: everything a viewer or the host needs, one thumb away. */}
      <nav className="lv-rail" aria-label="Live actions">
        <div className="lv-react">
          <button className="lv-rbtn heart" onClick={() => react('❤️')} onContextMenu={e => { e.preventDefault(); setTray(t => !t) }} disabled={phase !== 'live'} aria-label="Send a heart"><Heart size={26} fill="currentColor" /><span>{reactions || ''}</span></button>
          <button className="lv-rbtn sm" onClick={() => setTray(t => !t)} disabled={phase !== 'live'} aria-label="More reactions" aria-expanded={tray}>😊</button>
          {tray && <div className="lv-tray" role="group" aria-label="Reactions">{REACTIONS.map(e => <button key={e} onClick={() => { react(e); setTray(false) }} aria-label={`Send ${e}`}>{e}</button>)}</div>}
        </div>
        {!host && phase === 'live' && hostOnline && (stage === 'on'
          ? <button className="lv-rbtn" onClick={() => void leaveStage()} aria-label="Leave the stage"><LogOut size={24} /><span>Leave</span></button>
          : <button className={`lv-rbtn${stage === 'requested' ? ' on' : ''}`} onClick={requestStage} aria-pressed={stage === 'requested'} aria-label={stage === 'requested' ? 'Cancel your request to join' : 'Ask to join the live'}><UserPlus size={24} /><span>{stage === 'requested' ? 'Asked' : 'Join'}</span></button>)}
        {host && <button className="lv-rbtn" onClick={() => setGuestsOpen(true)} disabled={phase !== 'live'} aria-label={`Guests${requests.size ? `: ${requests.size} asking to join` : ''}`}><UserPlus size={24} /><span>Guests</span>{requests.size > 0 && <em className="lv-badge">{requests.size}</em>}</button>}
        {host && <button className="lv-rbtn" onClick={() => setPollOpen(true)} disabled={phase !== 'live'} aria-label="Start a poll"><BarChart3 size={24} /><span>Poll</span></button>}
        <button className={`lv-rbtn${chatOn ? '' : ' off'}`} onClick={() => setChatOn(c => !c)} aria-pressed={!chatOn} aria-label={chatOn ? 'Hide comments' : 'Show comments'}><MessageCircle size={24} /><span>{chat.length || ''}</span></button>
        <button className="lv-rbtn" onClick={() => void shareLive()} aria-label="Share this stream"><Share2 size={24} /><span>Share</span></button>
        {!publishing && <button className="lv-rbtn" onClick={() => setQuiet(q => !q)} aria-pressed={quiet} aria-label={quiet ? 'Turn sound on' : 'Turn sound off'}>{quiet ? <VolumeX size={24} /> : <Volume2 size={24} />}</button>}
        <button className="lv-rbtn" onClick={() => setStatsOpen(true)} disabled={phase !== 'live'} aria-label="Stream quality"><Gauge size={24} /></button>
        <button className="lv-rbtn" onClick={() => setClean(true)} aria-label="Clean view (video only)"><EyeOff size={24} /></button>
        {!host && <button className="lv-rbtn" onClick={() => setReporting(true)} aria-label="Report this stream"><Flag size={22} /></button>}
      </nav>

      <section aria-label="Live chat" className="lv-chat">
        {pinned && <p className="lv-pinned"><Pin size={14} aria-hidden /><b>{pinned.from === uid ? 'You' : (pinned.from && names.get(pinned.from)) || pinned.n}</b> {pinned.m}{host && <button className="lv-unpin" onClick={() => pin(null)} aria-label="Unpin"><PinOff size={14} /></button>}</p>}
        {chatOn && <ul className="lv-log" aria-live="polite">{chat.slice(-8).map(c => (
          <li key={c.id}><b>{c.from === uid ? 'You' : names.get(c.from) ?? c.name}</b> {c.text}
            {host && <button className="lv-remove" onClick={() => pin(c)}>Pin</button>}
            {host && c.from !== uid && <button className="lv-remove" onClick={() => void remove(c)}>Remove</button>}
          </li>))}
          {!chat.length && phase === 'live' && <li className="lv-hint">No comments yet. Say hello.</li>}</ul>}
        <div className="lv-bar">
          <form className="lv-form" onSubmit={e => { e.preventDefault(); void sendChat() }}>
            <input aria-label="Comment" placeholder="Add a comment…" value={text} maxLength={MAX_CHAT} onChange={e => setText(e.target.value)} disabled={phase !== 'live'} enterKeyHint="send" />
            <button aria-label="Send comment" disabled={phase !== 'live' || !text.trim()}><Send size={18} /></button>
          </form>
          {publishing && phase === 'live' && <>
            <button className={`lv-btn${mic ? '' : ' off'}`} onClick={toggleMic} aria-pressed={!mic} aria-label={mic ? 'Mute microphone' : 'Unmute microphone'}>{mic ? <Mic size={20} /> : <MicOff size={20} />}</button>
            <button className={`lv-btn${cam ? '' : ' off'}`} onClick={toggleCam} aria-pressed={!cam} aria-label={cam ? 'Turn camera off' : 'Turn camera on'}>{cam ? <Video size={20} /> : <VideoOff size={20} />}</button>
            <button className="lv-btn" onClick={() => void flip()} aria-label="Switch camera"><SwitchCamera size={20} /></button>
            {host && <button className="lv-btn end" onClick={end} aria-label="End stream">End</button>}
          </>}
        </div>
      </section>

      {guestsOpen && (
        <Sheet title="Guests" onClose={() => setGuestsOpen(false)}>
          <p className="t-meta" style={{ marginBottom: 10 }}>Up to {MAX_GUESTS} guests can join you on screen. They can turn their own camera and microphone off, and you can take them off stage at any time.</p>
          <h3 className="t-name" style={{ marginBottom: 6 }}>On stage ({guests.length}/{MAX_GUESTS})</h3>
          {guests.length ? <ul className="lv-people">{guests.map(g => <li key={g.id}><span className="grow">{g.name}</span><button className="btn sm" onClick={() => void unstage(g.id)}>Remove from stage</button></li>)}</ul> : <p className="t-meta" style={{ marginBottom: 10 }}>Nobody yet.</p>}
          <h3 className="t-name" style={{ margin: '12px 0 6px' }}>Asking to join ({requests.size})</h3>
          {requests.size ? <ul className="lv-people">{[...requests].map(([id, name]) => <li key={id}><span className="grow">{names.get(id) ?? name}</span>
            <button className="btn sm primary" disabled={guests.length >= MAX_GUESTS} onClick={() => void decide(id, true)}>Bring on stage</button>
            <button className="btn sm ghost" onClick={() => void decide(id, false)}>Not now</button></li>)}</ul>
            : <p className="t-meta">Viewers tap Join to ask. Their requests appear here.</p>}
        </Sheet>
      )}
      {pollOpen && <PollSheet onStart={startPoll} onClose={() => setPollOpen(false)} />}
      {reporting && <ReportSheet target={{ type: 'stream', id: s.id }} onClose={() => setReporting(false)} />}
      {statsOpen && <QualitySheet room={room.current} host={publishing} hostId={s.host} asked={asked} net={net} firstFrameMs={firstFrameMs} reconnects={reconnects} onClose={() => setStatsOpen(false)} />}
    </div>
  )
}

/** One person on stage: their camera (or their picture when it is off), their name and a muted-microphone mark. */
function StageTile({ t, solo, mirror, onShape, onFirstFrame }: { t: TileInfo; solo: boolean; mirror: boolean; onShape: (wide: boolean) => void; onFirstFrame: () => void }) {
  const v = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = v.current, track = t.video
    if (!el || !track) return
    track.attach(el)
    const shape = () => { if (solo && el.videoWidth && el.videoHeight) onShape(el.videoWidth > el.videoHeight) }
    el.addEventListener('loadedmetadata', shape); el.addEventListener('resize', shape)
    if (!t.local) el.addEventListener('playing', onFirstFrame, { once: true })
    return () => { el.removeEventListener('loadedmetadata', shape); el.removeEventListener('resize', shape); track.detach(el) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.video, solo])
  return (
    <div className={`lv-tile${t.video ? '' : ' off'}`}>
      {t.video ? <video ref={v} className={`live-video${mirror ? ' mirror' : ''}`} playsInline muted={t.local} autoPlay aria-label={`${t.name}’s video`} />
        : <span className="lv-tile-off" aria-hidden>{t.name.charAt(0).toUpperCase()}</span>}
      {!solo && <span className="lv-tile-name">{t.isHost ? '★ ' : ''}{t.name}{!t.micOn && <MicOff size={12} aria-label="microphone off" />}</span>}
    </div>
  )
}

/** Start a live poll: a question and two to four answers. Votes are live; everyone sees the percentages. */
function PollSheet({ onStart, onClose }: { onStart: (q: string, o: string[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [o, setO] = useState(['', ''])
  const ok = q.trim().length >= 2 && o.filter(x => x.trim()).length >= 2
  return (
    <Sheet title="Live poll" onClose={onClose}>
      <label className="field"><span className="t-name">Question</span><input className="input" value={q} maxLength={MAX_POLL_Q} onChange={e => setQ(e.target.value)} placeholder="e.g. Which song next?" autoFocus /></label>
      {o.map((x, i) => <label key={i} className="field"><span className="t-name">Answer {i + 1}</span><input className="input" value={x} maxLength={MAX_POLL_OPT} onChange={e => setO(a => a.map((y, j) => (j === i ? e.target.value : y)))} /></label>)}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn ghost" disabled={o.length >= 4} onClick={() => setO(a => [...a, ''])}>Add an answer</button>
        <button className="btn primary" disabled={!ok} onClick={() => onStart(q.trim(), o.map(x => x.trim()).filter(Boolean))}>Start poll</button>
      </div>
    </Sheet>
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
