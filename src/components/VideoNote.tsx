import { useEffect, useRef, useState } from 'react'
import { Play, RotateCcw, Send, Square, SwitchCamera, Video, X } from 'lucide-react'
import { useSigned, toast } from '../ui'
import { playSound } from '../lib/sounds'
import { micConstraints } from './VoiceNote'

/** Video notes: short round selfie clips (like voice notes, with your face). One minute at most, about 1 Mbps. */
export const MAX_VIDEO_NOTE_MS = 60_000
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

/** Best container the browser can record with video: WebM (Chrome, Firefox, Android) or MP4 (Safari). */
export function pickVideoType(): { mime: string; base: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) { const base = mime.split(';')[0]; return { mime, base, ext: base === 'video/mp4' ? 'mp4' : 'webm' } }
  }
  return null
}
export const videoNoteSupported = () => pickVideoType() !== null && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

/**
 * Record a video note: a round live preview, tap to record (it stops by itself at one minute), review, then send or redo.
 * The clip is handed over as a Blob; the caller uploads it (comments, unencrypted chats) or encrypts it first (secure chats).
 */
export function VideoNoteButton({ onSend, disabled, label = 'Record a video note' }: { onSend: (clip: { blob: Blob; mime: string; ms: number }) => Promise<void>; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false)
  if (!videoNoteSupported()) return null
  return (
    <>
      <button type="button" className="icon-btn vn-btn" aria-label={label} title={label} disabled={disabled} onClick={() => setOpen(true)}><Video size={20} /></button>
      {open && <VideoNoteRecorder onClose={() => setOpen(false)} onSend={async c => { await onSend(c); setOpen(false) }} />}
    </>
  )
}

function VideoNoteRecorder({ onClose, onSend }: { onClose: () => void; onSend: (clip: { blob: Blob; mime: string; ms: number }) => Promise<void> }) {
  const live = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const started = useRef(0)
  const timer = useRef<number | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const [round, setRound] = useState(0)                           // bumps to restart the camera after Redo
  const [state, setState] = useState<'starting' | 'ready' | 'recording' | 'review' | 'sending' | 'error'>('starting')
  const [ms, setMs] = useState(0)
  const [clip, setClip] = useState<{ blob: Blob; mime: string; ms: number; url: string } | null>(null)
  const [err, setErr] = useState('')

  const stopTracks = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null }
  useEffect(() => {
    let alive = true
    setState('starting')
    navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 720 } }, audio: micConstraints })
      .then(s => { if (!alive) { s.getTracks().forEach(t => t.stop()); return } stopTracks(); stream.current = s; if (live.current) { live.current.srcObject = s; void live.current.play().catch(() => {}) } setState('ready') })
      .catch(() => { if (alive) { setErr('Allow the camera and microphone to record a video note.'); setState('error') } })
    return () => { alive = false }
  }, [facing, round])
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); if (rec.current?.state === 'recording') rec.current.stop(); stopTracks() }, [])
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url) }, [clip])

  const start = () => {
    const type = pickVideoType(); if (!type || !stream.current) return
    chunks.current = []
    const r = new MediaRecorder(stream.current, { mimeType: type.mime, videoBitsPerSecond: 900_000, audioBitsPerSecond: 64_000 })
    rec.current = r
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = () => {
      if (timer.current) clearInterval(timer.current)
      const took = Math.min(Date.now() - started.current, MAX_VIDEO_NOTE_MS)
      const blob = new Blob(chunks.current, { type: type.base })
      if (took < 800 || !blob.size) { toast('Hold on a little longer to record.'); setState('ready'); return }
      setClip({ blob, mime: type.base, ms: took, url: URL.createObjectURL(blob) }); setState('review')
    }
    r.start(250); started.current = Date.now(); setMs(0); setState('recording'); playSound('record')
    timer.current = window.setInterval(() => { const t = Date.now() - started.current; setMs(t); if (t >= MAX_VIDEO_NOTE_MS && r.state === 'recording') r.stop() }, 200)
  }
  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop() }
  const send = async () => {
    if (!clip) return
    setState('sending')
    try { await onSend({ blob: clip.blob, mime: clip.mime, ms: clip.ms }); stopTracks() } catch (e) { toast((e as Error).message || 'The video note could not be sent.'); setState('review') }
  }

  return (
    <div className="vn-sheet" role="dialog" aria-modal="true" aria-label="Record a video note">
      <button className="vn-close icon-btn" aria-label="Close" onClick={() => { stopTracks(); onClose() }}><X size={22} /></button>
      <div className={`vn-circle${state === 'recording' ? ' rec' : ''}`} style={{ ['--p' as string]: `${(ms / MAX_VIDEO_NOTE_MS) * 100}` }}>
        {state !== 'review' && state !== 'sending' && <video ref={live} muted playsInline autoPlay className={facing === 'user' ? 'mirror' : ''} aria-label="Camera preview" />}
        {(state === 'review' || state === 'sending') && clip && <video src={clip.url} playsInline autoPlay loop controls={false} aria-label="Your video note" />}
      </div>
      <p className="vnote-time" role="status">{state === 'recording' ? `● ${fmt(ms)} / 1:00` : state === 'review' ? `${fmt(clip?.ms ?? 0)} recorded` : state === 'error' ? err : state === 'starting' ? 'Starting the camera…' : 'Tap to record (up to a minute)'}</p>
      <div className="vn-controls">
        {(state === 'ready' || state === 'recording') && <button className="icon-btn vn-flip" aria-label="Switch camera" disabled={state === 'recording'} onClick={() => setFacing(f => (f === 'user' ? 'environment' : 'user'))}><SwitchCamera size={22} /></button>}
        {state === 'ready' && <button className="vn-rec" aria-label="Start recording" onClick={start}><span /></button>}
        {state === 'recording' && <button className="vn-rec on" aria-label="Stop recording" onClick={stop}><Square size={22} /></button>}
        {(state === 'review' || state === 'sending') && <>
          <button className="btn" disabled={state === 'sending'} onClick={() => { setClip(null); setState('starting'); setRound(r => r + 1) }}><RotateCcw size={18} aria-hidden /> Redo</button>
          <button className="btn primary" disabled={state === 'sending'} onClick={() => void send()}><Send size={18} aria-hidden /> {state === 'sending' ? 'Sending…' : 'Send'}</button>
        </>}
      </div>
    </div>
  )
}

/** A video note as received: a round clip that plays muted in place; tap to hear it. */
export function VideoNotePlayer({ path, url: given, ms }: { path?: string | null; url?: string | null; ms?: number | null }) {
  const signed = useSigned(given ? null : path ?? null)
  const url = given ?? signed
  const v = useRef<HTMLVideoElement>(null)
  const [sound, setSound] = useState(false)
  if (!url) return <span className="vn-bubble skeleton" aria-hidden />
  return (
    <button type="button" className={`vn-bubble${sound ? ' on' : ''}`} aria-label={sound ? 'Mute video note' : `Play video note${ms ? `, ${fmt(ms)}` : ''} with sound`}
      onClick={() => { const el = v.current; if (!el) return; const next = !sound; el.muted = !next; if (next) { el.currentTime = 0; void el.play() } setSound(next) }}>
      <video ref={v} src={`${url}#t=0.1`} muted autoPlay loop playsInline preload="auto" />
      {!sound && <span className="vnote-play" aria-hidden><Play size={22} fill="currentColor" /></span>}
      {ms ? <span className="vn-dur" aria-hidden>{fmt(ms)}</span> : null}
    </button>
  )
}
