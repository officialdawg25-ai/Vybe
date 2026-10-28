import { useEffect, useRef, useState } from 'react'
import { Globe, MessageCircleOff, Music2, Pause, Play, Send, Users, Volume2, VolumeX, X } from 'lucide-react'
import { Sheet } from '../../ui'
import { fileSize } from '../../lib/media'
import { MIN_CLIP, clampTrim, clock, frameStrip, type VideoEdit } from '../../lib/videoEdit'
import { type PickedSong } from '../../pages/create/pickers'

/**
 * The video editor shown when a video is added to a post (the way WhatsApp's status editor works): drag the two ends of the
 * strip to choose where the video starts and stops, add or change the song, switch the video's own sound off, and decide who
 * sees it and what they can do. Nothing is re-encoded: the choices are stored with the post and applied when it plays.
 */
export function VideoEditor({ url, bytes, caption, onCaption, onPost, initial, song, onMusic, onRemoveSong, canAudience, visibility, onVisibility, commentsOff, onCommentsOff, hideCounts, onHideCounts, onDone, onCancel }: {
  url: string; bytes: number; caption: string; onCaption: (t: string) => void; onPost: (e: VideoEdit | null, duration: number | null) => void; initial: VideoEdit | null; song: PickedSong | null; onMusic: () => void; onRemoveSong: () => void
  canAudience: boolean; visibility: 'public' | 'friends'; onVisibility: (v: 'public' | 'friends') => void
  commentsOff: boolean; onCommentsOff: (v: boolean) => void; hideCounts: boolean; onHideCounts: (v: boolean) => void
  onDone: (e: VideoEdit | null, duration: number | null) => void; onCancel: () => void
}) {
  const vid = useRef<HTMLVideoElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const [dur, setDur] = useState<number | null>(null)
  const [range, setRange] = useState({ start: initial?.start ?? 0, end: initial?.end ?? 0 })
  const [muted, setMuted] = useState(initial?.muted ?? false)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [frames, setFrames] = useState<string[]>([])
  const [sheet, setSheet] = useState(false)
  const drag = useRef<null | 'start' | 'end'>(null)
  const rangeRef = useRef(range); rangeRef.current = range

  const probed = useRef(false), started = useRef(false)
  const onMeta = () => {
    const v = vid.current; if (!v) return
    const d = v.duration
    if (d === Infinity && !probed.current) { probed.current = true; v.currentTime = 1e101; return }   // browser-recorded WebM has no length until it is read to the end
    if (Number.isFinite(d) && d > 0) {
      if (probed.current && v.currentTime > d - 0.01) v.currentTime = initial?.start ?? 0
      setDur(d)
      setRange(r => (r.end > 0 && r.end <= d + 0.01 ? r : { start: 0, end: d }))
      if (!started.current) { started.current = true; void frameStrip(url, d).then(setFrames) }
    } else if (!probed.current) setDur(null)
  }
  // Loops inside the chosen part.
  const onTime = () => {
    const v = vid.current; if (!v) return
    const { start, end } = rangeRef.current
    if (end > 0 && v.currentTime >= end) v.currentTime = start
    setPos(v.currentTime)
  }
  const toggle = () => {
    const v = vid.current; if (!v) return
    if (v.paused) { v.muted = muted; if (v.currentTime < range.start || v.currentTime >= range.end) v.currentTime = range.start; void v.play().then(() => setPlaying(true), () => setPlaying(false)) }
    else { v.pause(); setPlaying(false) }
  }
  useEffect(() => { if (vid.current) vid.current.muted = muted || !playing }, [muted, playing])

  const fracOf = (clientX: number) => { const r = strip.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) }
  const move = (clientX: number) => {
    if (!drag.current || !dur) return
    const t = fracOf(clientX) * dur
    const next = drag.current === 'start' ? clampTrim(t, range.end, dur, 'start') : clampTrim(range.start, t, dur, 'end')
    setRange(next)
    const v = vid.current; if (v) { v.pause(); setPlaying(false); v.currentTime = drag.current === 'start' ? next.start : Math.max(next.start, next.end - 0.1) }
  }
  const key = (which: 'start' | 'end') => (e: React.KeyboardEvent) => {
    if (!dur) return
    const step = e.shiftKey ? 1 : 0.1, dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    setRange(r => (which === 'start' ? clampTrim(r.start + dir * step, r.end, dur, 'start') : clampTrim(r.start, r.end + dir * step, dur, 'end')))
  }
  const result = (): VideoEdit | null => {
    const whole = dur != null && range.start <= 0.05 && range.end >= dur - 0.05
    return whole && !muted ? null : { start: range.start, end: range.end || (dur ?? 0), muted }
  }
  const done = () => onDone(result(), dur)
  const post = () => onPost(result(), dur)
  const pct = (t: number) => (dur ? `${(t / dur) * 100}%` : '0%')
  const len = Math.max(0, range.end - range.start)

  const audienceLabel = !canAudience ? 'This post' : visibility === 'public' ? 'Public' : 'Friends'
  return (
    <div className="ve ve-wa" role="dialog" aria-modal="true" aria-label="Edit video">
      <div className="ve-stage">
        <video ref={vid} src={url} playsInline muted loop={false} preload="auto" onLoadedMetadata={onMeta} onDurationChange={onMeta} onTimeUpdate={onTime} onEnded={() => { const v = vid.current; if (v) { v.currentTime = range.start; void v.play().catch(() => {}) } }} onClick={toggle} aria-label="Video preview" />
        <button className="ve-play" onClick={toggle} aria-label={playing ? 'Pause preview' : 'Play preview'}>{playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}</button>
      </div>

      <header className="ve-top">
        <button className="ve-round" aria-label="Cancel editing" onClick={onCancel}><X size={24} /></button>
        <span className="grow" />
        <button className={`ve-round${song ? ' on' : ''}`} aria-label={song ? `Song: ${song.title}. Change` : 'Add music'} onClick={onMusic}><Music2 size={22} /></button>
        <button className={`ve-round${muted ? ' on' : ''}`} aria-label={muted ? 'Turn the video’s sound on' : 'Turn the video’s sound off'} aria-pressed={muted} onClick={() => setMuted(m => !m)}>{muted ? <VolumeX size={22} /> : <Volume2 size={22} />}</button>
      </header>

      <div className="ve-trim" aria-label="Trim">
        {dur != null ? (
          <div className="ve-strip" ref={strip} onPointerMove={e => move(e.clientX)} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
            <div className="ve-frames" aria-hidden>{frames.length ? frames.map((f, i) => <i key={i} style={{ backgroundImage: `url(${f})` }} />) : <i className="ve-nof" />}</div>
            <span className="ve-dim" style={{ left: 0, width: pct(range.start) }} aria-hidden />
            <span className="ve-dim" style={{ right: 0, width: dur ? `${((dur - range.end) / dur) * 100}%` : 0 }} aria-hidden />
            <span className="ve-window" style={{ left: pct(range.start), width: dur ? `${((range.end - range.start) / dur) * 100}%` : 0 }} aria-hidden />
            <span className="ve-head-line" style={{ left: pct(Math.min(Math.max(pos, range.start), range.end)) }} aria-hidden />
            <button className="ve-handle start" style={{ left: pct(range.start) }} role="slider" aria-label="Start of the video" aria-valuemin={0} aria-valuemax={Math.max(0, Math.round((range.end - MIN_CLIP) * 10) / 10)} aria-valuenow={Math.round(range.start * 10) / 10} aria-valuetext={clock(range.start)}
              onPointerDown={e => { drag.current = 'start'; e.currentTarget.setPointerCapture(e.pointerId) }} onKeyDown={key('start')} />
            <button className="ve-handle end" style={{ left: pct(range.end) }} role="slider" aria-label="End of the video" aria-valuemin={Math.round((range.start + MIN_CLIP) * 10) / 10} aria-valuemax={Math.round(dur * 10) / 10} aria-valuenow={Math.round(range.end * 10) / 10} aria-valuetext={clock(range.end)}
              onPointerDown={e => { drag.current = 'end'; e.currentTarget.setPointerCapture(e.pointerId) }} onKeyDown={key('end')} />
          </div>
        ) : <p className="ve-hint">Loading the video…</p>}
        <p className="ve-meta"><span>{muted ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}</span><span>{clock(len)}</span><span aria-hidden>•</span><span>{fileSize(bytes)}</span>{song && <><span aria-hidden>•</span><span className="clamp-1 ve-song"><Music2 size={14} aria-hidden /> {song.title}</span><button className="ve-x" aria-label="Remove song" onClick={onRemoveSong}><X size={14} /></button></>}</p>
      </div>

      <div className="ve-bottom">
        <div className="ve-caption">
          <input aria-label="Add a caption" placeholder="Add a caption…" value={caption} maxLength={5000} onChange={e => onCaption(e.target.value)} />
        </div>
        <div className="ve-send-row">
          <button className="ve-aud" onClick={() => setSheet(true)} aria-haspopup="dialog" aria-label={`Audience and controls: ${audienceLabel}`}>{visibility === 'public' || !canAudience ? <Globe size={16} aria-hidden /> : <Users size={16} aria-hidden />} {audienceLabel}{commentsOff ? ' · comments off' : ''}</button>
          <span className="grow" />
          <button className="ve-done" onClick={done}>Done</button>
          <button className="ve-send" onClick={post} aria-label="Post video"><Send size={22} /></button>
        </div>
      </div>
      {len > 0 && len < MIN_CLIP + 0.01 && <p className="ve-hint ve-warn" role="status">A video must play for at least half a second.</p>}
      <span className="sr-only" role="status">{dur != null ? `Playing from ${clock(range.start)} to ${clock(range.end)}` : ''}</span>

      {sheet && (
        <Sheet title="Who sees it and what they can do" onClose={() => setSheet(false)}>
          <div className="stack ve-sheet" style={{ gap: 10 }}>
            {canAudience && (
              <div className="ve-seg" role="radiogroup" aria-label="Audience">
                <button role="radio" aria-checked={visibility === 'public'} className={visibility === 'public' ? 'on' : ''} onClick={() => onVisibility('public')}><Globe size={16} aria-hidden /> Public</button>
                <button role="radio" aria-checked={visibility === 'friends'} className={visibility === 'friends' ? 'on' : ''} onClick={() => onVisibility('friends')}><Users size={16} aria-hidden /> Friends</button>
              </div>
            )}
            <Switch label="Allow comments" icon={<MessageCircleOff size={18} aria-hidden />} on={!commentsOff} onChange={v => onCommentsOff(!v)} />
            <Switch label="Show like and comment counts" on={!hideCounts} onChange={v => onHideCounts(!v)} />
            <button className="btn primary" onClick={() => setSheet(false)}>Done</button>
          </div>
        </Sheet>
      )}
    </div>
  )
}

function Switch({ label, icon, on, onChange }: { label: string; icon?: React.ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className="ve-switch" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      {icon}<span className="grow">{label}</span><span className={`ve-sw${on ? ' on' : ''}`} aria-hidden><i /></span>
    </button>
  )
}
