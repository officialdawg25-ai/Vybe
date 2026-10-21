import { useEffect, useRef, useState } from 'react'
import { Mic, Pause, Play, Send, Square, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { mediaPath } from '../lib/media'
import { useSigned, errMsg, toast } from '../ui'
import { playSound } from '../lib/sounds'

/** Voice notes have no time limit. Recording stops by itself only when the file nears the storage upload limit. */
export const MAX_VOICE_BYTES = 48 * 1024 * 1024
export const VOICE_BITRATE = 96_000
const fmt = (ms: number) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}` }

/** Best container the browser can record: WebM/Opus (Chrome, Firefox, Android), MP4/AAC (Safari). */
export function pickRecorderType(): { mime: string; base: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, base: mime.split(';')[0] }
  }
  return null
}

/** Microphone settings tuned for speech: mono 48 kHz with echo cancellation, noise suppression and automatic gain. */
export const micConstraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 }

/** Record as long as you like (pause and resume too), review, then send as a voice note. */
export function VoiceRecorder({ uid, onSend, onBlob, disabled }: { uid: string; onSend: (audio: { path: string; ms: number }) => Promise<void>; /** Hands over the raw recording instead of uploading it (used by end-to-end encrypted chats). */ onBlob?: (clip: { blob: Blob; mime: string; ms: number }) => Promise<void>; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'recording' | 'paused' | 'review'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [clip, setClip] = useState<{ blob: Blob; base: string; ms: number; url: string } | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const bytes = useRef(0)
  const acc = useRef(0), since = useRef(0)            // recorded time before the current run, and when the current run began
  const tick = useRef<number | null>(null)
  const cancelled = useRef(false)
  const supported = pickRecorderType() !== null && Boolean(navigator.mediaDevices?.getUserMedia)
  const now = () => acc.current + (since.current ? performance.now() - since.current : 0)

  const release = () => { if (tick.current) window.clearInterval(tick.current); tick.current = null; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null }
  useEffect(() => () => { cancelled.current = true; if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); release() }, [])
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url) }, [clip])

  const start = async () => {
    const type = pickRecorderType(); if (!type) return
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints })
      stream.current = s; chunks.current = []; bytes.current = 0; acc.current = 0; cancelled.current = false
      const r = new MediaRecorder(s, { mimeType: type.mime, audioBitsPerSecond: VOICE_BITRATE })
      rec.current = r
      r.ondataavailable = e => { if (e.data.size) { chunks.current.push(e.data); bytes.current += e.data.size; if (bytes.current >= MAX_VOICE_BYTES && r.state !== 'inactive') { toast('That is the longest a single voice note can be. Send it and record another to continue.'); stop() } } }
      r.onstop = () => {
        const ms = Math.round(now()); since.current = 0
        release()
        if (cancelled.current) return
        const blob = new Blob(chunks.current, { type: type.base })
        if (ms < 700 || !blob.size) { toast('Hold on a little longer to record.'); setState('idle'); return }
        setClip({ blob, base: type.base, ms, url: URL.createObjectURL(blob) }); setState('review')
      }
      since.current = performance.now(); r.start(1000)
      setElapsed(0); setState('recording'); playSound('record')
      tick.current = window.setInterval(() => setElapsed(now()), 200)
    } catch (e) {
      release()
      toast((e as DOMException)?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings to record.' : 'Could not start recording on this device.')
    }
  }
  const stop = () => { if (rec.current && rec.current.state !== 'inactive') { rec.current.stop(); playSound('stop') } }
  const pause = () => { const r = rec.current; if (!r || r.state !== 'recording') return; acc.current = now(); since.current = 0; r.pause(); setState('paused') }
  const resume = () => { const r = rec.current; if (!r || r.state !== 'paused') return; since.current = performance.now(); r.resume(); setState('recording') }
  const discard = () => { cancelled.current = true; if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); release(); setClip(null); setState('idle') }
  const send = async () => {
    if (!clip || busy) return
    setBusy(true)
    try {
      if (onBlob) { await onBlob({ blob: clip.blob, mime: clip.base, ms: clip.ms }); setClip(null); setState('idle'); return }
      const ext = clip.base === 'audio/mp4' ? 'm4a' : clip.base === 'audio/ogg' ? 'ogg' : 'webm'
      const path = mediaPath(uid, clip.base).replace(/\.[^.]+$/, `.${ext}`)
      const up = await supabase.storage.from('media').upload(path, clip.blob, { contentType: clip.base, upsert: false })
      if (up.error) throw new Error(/exceeded|too large|maximum/i.test(up.error.message) ? 'That recording is larger than your storage upload limit. Raise it in Supabase → Storage → Settings, or send shorter notes.' : up.error.message)
      try { await onSend({ path, ms: clip.ms }) } catch (e) { await supabase.storage.from('media').remove([path]); throw e }
      setClip(null); setState('idle')
    } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }

  if (!supported) return null
  if (state === 'idle') return <button className="icon-btn" type="button" aria-label="Record a voice note" title="Record a voice note" disabled={disabled} onClick={start}><Mic size={22} /></button>
  if (state === 'recording' || state === 'paused') {
    return (
      <div className="voice-rec" role="group" aria-label={state === 'paused' ? 'Voice note paused' : 'Recording voice note'}>
        <span className={`rec-dot${state === 'paused' ? ' still' : ''}`} aria-hidden />
        <span className="t-name voice-time" aria-live="off">{fmt(elapsed)}</span>
        <div className="voice-bar" aria-hidden><i className={state === 'recording' ? 'live' : ''} /></div>
        <button className="icon-btn" type="button" aria-label="Cancel recording" onClick={discard}><Trash2 size={20} /></button>
        <button className="icon-btn" type="button" aria-label={state === 'paused' ? 'Resume recording' : 'Pause recording'} onClick={state === 'paused' ? resume : pause}>{state === 'paused' ? <Mic size={20} /> : <Pause size={20} />}</button>
        <button className="btn primary sm" type="button" onClick={stop}><Square size={14} aria-hidden fill="currentColor" /> Done</button>
      </div>
    )
  }
  return (
    <div className="voice-rec" role="group" aria-label="Review voice note">
      {clip && <audio src={clip.url} controls preload="metadata" style={{ height: 36, flex: 1, minWidth: 0 }} />}
      <span className="t-meta">{clip ? fmt(clip.ms) : ''}</span>
      <button className="icon-btn" type="button" aria-label="Discard voice note" onClick={discard} disabled={busy}><Trash2 size={20} /></button>
      <button className="btn primary sm" type="button" onClick={send} disabled={busy}><Send size={14} aria-hidden /> {busy ? 'Sending…' : 'Send'}</button>
    </div>
  )
}

const SPEEDS = [1, 1.5, 2]
/** Playback for a voice note: play/pause, a seek bar that works for long notes, and 1×/1.5×/2× speed. */
export function VoiceNote({ path, ms, src }: { path: string; ms: number; /** A ready-to-play URL (an already-decrypted blob); skips signing the path. */ src?: string | null }) {
  const signed = useSigned(src === undefined ? path : null)
  const url = src === undefined ? signed : src
  const el = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [speed, setSpeed] = useState(1)
  const toggle = () => { const a = el.current; if (!a) return; a.paused ? void a.play() : a.pause() }
  const seek = (v: number) => { const a = el.current; if (a) { a.currentTime = (v / 1000) * (ms / 1000); setPos(v / 1000 * ms) } }
  const cycle = () => { const n = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; setSpeed(n); if (el.current) el.current.playbackRate = n }
  return (
    <div className="voice-note">
      <button className="vn-play" type="button" onClick={toggle} disabled={!url} aria-label={playing ? 'Pause voice note' : `Play voice note, ${fmt(ms)}`}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
      <input className="vn-seek" type="range" min={0} max={1000} step={1} value={Math.min(1000, Math.round((pos / Math.max(ms, 1)) * 1000))} onChange={e => seek(Number(e.target.value))} aria-label="Seek voice note" disabled={!url} />
      <span className="t-meta vn-time">{fmt(playing || pos > 0 ? pos : ms)}</span>
      {ms > 15000 && <button className="vn-speed" type="button" onClick={cycle} aria-label={`Playback speed ${speed}×`}>{speed}×</button>}
      {url && <audio ref={el} src={url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0) }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime * 1000)} />}
    </div>
  )
}
