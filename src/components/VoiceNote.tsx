import { useEffect, useRef, useState } from 'react'
import { Mic, Pause, Play, Send, Square, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { mediaPath } from '../lib/media'
import { useSigned, errMsg, toast } from '../ui'
import { playSound } from '../lib/sounds'

export const MAX_VOICE_MS = 60_000
const fmt = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** Best container the browser can record: WebM/Opus (Chrome, Firefox, Android), MP4/AAC (Safari). */
export function pickRecorderType(): { mime: string; base: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, base: mime.split(';')[0] }
  }
  return null
}

/** Record up to 60 seconds, review, then send as a comment's voice note. */
export function VoiceRecorder({ uid, onSend, disabled }: { uid: string; onSend: (audio: { path: string; ms: number }) => Promise<void>; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'recording' | 'review'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [clip, setClip] = useState<{ blob: Blob; base: string; ms: number; url: string } | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const started = useRef(0)
  const tick = useRef<number | null>(null)
  const cancelled = useRef(false)
  const supported = pickRecorderType() !== null && Boolean(navigator.mediaDevices?.getUserMedia)

  const release = () => { if (tick.current) window.clearInterval(tick.current); tick.current = null; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null }
  useEffect(() => () => { cancelled.current = true; if (rec.current?.state === 'recording') rec.current.stop(); release() }, [])
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url) }, [clip])

  const start = async () => {
    const type = pickRecorderType(); if (!type) return
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      stream.current = s; chunks.current = []; cancelled.current = false
      const r = new MediaRecorder(s, { mimeType: type.mime, audioBitsPerSecond: 48_000 })
      rec.current = r
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      r.onstop = () => {
        const ms = Math.min(MAX_VOICE_MS, Math.round(performance.now() - started.current))
        release()
        if (cancelled.current) return
        const blob = new Blob(chunks.current, { type: type.base })
        if (ms < 700 || !blob.size) { toast('Hold on a little longer to record.'); setState('idle'); return }
        setClip({ blob, base: type.base, ms, url: URL.createObjectURL(blob) }); setState('review')
      }
      started.current = performance.now(); r.start(250)
      setElapsed(0); setState('recording'); playSound('record')
      tick.current = window.setInterval(() => {
        const e = performance.now() - started.current
        setElapsed(e)
        if (e >= MAX_VOICE_MS) stop()           // hard 60-second limit
      }, 100)
    } catch (e) {
      release()
      toast((e as DOMException)?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings to record.' : 'Could not start recording on this device.')
    }
  }
  const stop = () => { if (rec.current?.state === 'recording') { rec.current.stop(); playSound('stop') } }
  const discard = () => { cancelled.current = true; if (rec.current?.state === 'recording') rec.current.stop(); release(); setClip(null); setState('idle') }
  const send = async () => {
    if (!clip || busy) return
    setBusy(true)
    try {
      const ext = clip.base === 'audio/mp4' ? 'm4a' : clip.base === 'audio/ogg' ? 'ogg' : 'webm'
      const path = mediaPath(uid, clip.base).replace(/\.[^.]+$/, `.${ext}`)
      const up = await supabase.storage.from('media').upload(path, clip.blob, { contentType: clip.base, upsert: false })
      if (up.error) throw new Error(up.error.message)
      try { await onSend({ path, ms: Math.min(clip.ms, MAX_VOICE_MS) }) } catch (e) { await supabase.storage.from('media').remove([path]); throw e }
      setClip(null); setState('idle')
    } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }

  if (!supported) return null
  if (state === 'idle') return <button className="icon-btn" type="button" aria-label="Record a voice note (up to 60 seconds)" title="Record a voice note (up to 60 s)" disabled={disabled} onClick={start}><Mic size={22} /></button>
  if (state === 'recording') {
    const left = Math.max(0, Math.ceil((MAX_VOICE_MS - elapsed) / 1000))
    return (
      <div className="voice-rec" role="group" aria-label="Recording voice note">
        <span className="rec-dot" aria-hidden />
        <span className="t-name" aria-live="off">{fmt(elapsed)}</span><span className="t-meta">/ 1:00{left <= 10 ? ` · ${left}s left` : ''}</span>
        <div className="voice-bar" aria-hidden><i style={{ width: `${Math.min(100, (elapsed / MAX_VOICE_MS) * 100)}%` }} /></div>
        <button className="icon-btn" type="button" aria-label="Cancel recording" onClick={discard}><Trash2 size={20} /></button>
        <button className="btn primary sm" type="button" onClick={stop}><Square size={14} aria-hidden fill="currentColor" /> Stop</button>
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

/** Playback for a voice-note comment. */
export function VoiceNote({ path, ms }: { path: string; ms: number }) {
  const url = useSigned(path)
  const el = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const toggle = () => { const a = el.current; if (!a) return; a.paused ? void a.play() : a.pause() }
  return (
    <div className="voice-note">
      <button className="icon-btn" type="button" onClick={toggle} disabled={!url} aria-label={playing ? 'Pause voice note' : `Play voice note, ${fmt(ms)}`}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
      <div className="voice-bar" aria-hidden><i style={{ width: `${Math.min(100, (pos / ms) * 100)}%` }} /></div>
      <span className="t-meta">{fmt(playing ? pos : ms)}</span>
      {url && <audio ref={el} src={url} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0) }}
        onTimeUpdate={e => setPos(e.currentTarget.currentTime * 1000)} />}
    </div>
  )
}
