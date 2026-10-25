import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Grid3x3, ImagePlus, Layers, Music2, RefreshCw, Settings, Sparkles, Timer, Trash2, X, Zap, ZapOff } from 'lucide-react'
import { FILTERS, SPEEDS, filterCss, loadCameraPrefs, saveCameraPrefs, songUrl, useSongPlayer, type CameraPrefs, type FilterKey, type StudioSong } from '../../lib/studio'
import { TrackArt } from '../../pages/create/pickers'
import { MusicSheet } from './MusicSheet'
import { StudioSheet } from './Overlays'
import { toast } from '../../ui'

export interface Take { file: File; speed: number; filter: FilterKey }

/**
 * The reel camera: record in several takes (tap to start, tap to pause, tap again to continue) up to the chosen length,
 * with a countdown timer, speed, flash, live effects, an "align" ghost of the last frame, a grid and the song playing as you
 * record. Gallery picks a finished video instead. Story switches to the memory studio. Preferences stay on this device.
 */
export function ReelCamera({ song, onSong, onTake, onPickFile, onClose }: { song: StudioSong | null; onSong: (s: StudioSong | null) => void; onTake: (t: Take) => void; onPickFile: (f: File) => void; onClose: () => void }) {
  const nav = useNavigate()
  const [prefs, setPrefsState] = useState<CameraPrefs>(loadCameraPrefs)
  const setPrefs = (p: Partial<CameraPrefs>) => setPrefsState(x => { const n = { ...x, ...p }; saveCameraPrefs(n); return n })
  const [facing, setFacing] = useState<'user' | 'environment'>(prefs.front ? 'user' : 'environment')
  const [ready, setReady] = useState(false)
  const [denied, setDenied] = useState('')
  const [torch, setTorch] = useState<boolean | null>(null)        // null: the camera has no torch
  const [speed, setSpeed] = useState(1)
  const [timer, setTimer] = useState<0 | 3 | 10>(0)
  const [count, setCount] = useState(0)
  const [filter, setFilter] = useState<FilterKey>('none')
  const [panel, setPanel] = useState<'effects' | 'music' | 'settings' | null>(null)
  const [align, setAlign] = useState(false)
  const [ghost, setGhost] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'rec' | 'paused'>('idle')
  const [ms, setMs] = useState(0)
  const [marks, setMarks] = useState<number[]>([])
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const tick = useRef<{ t: number; base: number } | null>(null)
  const raf = useRef<number | null>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const max = prefs.duration * 1000

  // Song plays while recording (from its chosen moment), so moves land on the beat.
  const [src, setSrc] = useState<string | null>(null)
  const [local, setLocal] = useState<string | null>(null)
  useEffect(() => { const u = song?.file ? URL.createObjectURL(song.file) : null; setLocal(u); return () => { if (u) URL.revokeObjectURL(u) } }, [song?.file])
  useEffect(() => { let live = true; if (!song) { setSrc(null); return } void songUrl(song, local).then(u => live && setSrc(u)); return () => { live = false } }, [song, local])
  const [songAt, setSongAt] = useState(0)          // where the song resumes: its chosen start plus what is already recorded
  useSongPlayer(src, { playing: state === 'rec', start_ms: (song?.start_ms ?? 0) + songAt, clip_ms: max })

  const stop = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null }
  useEffect(() => {
    let live = true; setReady(false)
    ;(async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setDenied('This browser cannot open the camera. Choose a video from your gallery.'); return }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 } }, audio: true })
        if (!live) { s.getTracks().forEach(t => t.stop()); return }
        stop(); stream.current = s
        const caps = (s.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as { torch?: boolean }
        setTorch(caps.torch ? false : null)
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}) }
        setReady(true); setDenied('')
      } catch (e) {
        if (live) setDenied((e as DOMException)?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser settings, or choose a video from your gallery.' : 'Could not open the camera on this device. Choose a video from your gallery.')
      }
    })()
    return () => { live = false }
  }, [facing])
  useEffect(() => () => { stop(); if (raf.current) cancelAnimationFrame(raf.current); if (rec.current && rec.current.state !== 'inactive') { rec.current.onstop = null; rec.current.stop() } }, [])

  const setFlash = async (on: boolean) => {
    const t = stream.current?.getVideoTracks()[0]; if (!t) return
    try { await t.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }); setTorch(on) } catch { toast('Flash is not available on this camera.') }
  }
  const frame = () => {
    const v = video.current; if (!v?.videoWidth) return null
    const c = document.createElement('canvas'); c.width = Math.min(540, v.videoWidth); c.height = Math.round(c.width * (v.videoHeight / v.videoWidth))
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.6)
  }
  const loop = useCallback(() => {
    const k = tick.current; if (!k) return
    const now = k.base + (performance.now() - k.t)
    setMs(now)
    if (now >= max) { finish(); return }
    raf.current = requestAnimationFrame(loop)
  }, [max]) // eslint-disable-line react-hooks/exhaustive-deps

  const begin = () => {
    const s = stream.current; if (!s) return
    if (!rec.current) {
      const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))
      const r = new MediaRecorder(s, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined)
      chunks.current = []
      r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      r.onstop = () => {
        const type = (r.mimeType || 'video/webm').split(';')[0]
        const blob = new Blob(chunks.current, { type })
        rec.current = null
        if (blob.size) onTake({ file: new File([blob], `reel-${Date.now()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type }), speed, filter })
      }
      rec.current = r; r.start(1000)
    } else rec.current.resume()
    tick.current = { t: performance.now(), base: ms }; setSongAt(ms)
    setState('rec'); raf.current = requestAnimationFrame(loop)
  }
  const pause = () => {
    if (rec.current?.state === 'recording') rec.current.pause()
    if (raf.current) cancelAnimationFrame(raf.current); tick.current = null
    setMarks(m => [...m, ms]); setGhost(frame()); setState('paused')
  }
  const finish = () => {
    if (raf.current) cancelAnimationFrame(raf.current); tick.current = null
    if (!rec.current) return
    if (ms < 1000 && state !== 'rec') { toast('Record at least a second.'); return }
    if (rec.current.state === 'paused') rec.current.resume()
    rec.current.stop(); setState('idle')
  }
  const discard = () => {
    if (!confirm('Discard what you recorded?')) return
    if (rec.current) { rec.current.onstop = null; if (rec.current.state !== 'inactive') rec.current.stop(); rec.current = null }
    chunks.current = []; setMs(0); setSongAt(0); setMarks([]); setGhost(null); setState('idle')
  }
  const shutter = () => {
    if (!ready || count) return
    if (state === 'rec') return pause()
    if (timer) {
      let n = timer; setCount(n)
      const t = window.setInterval(() => { n -= 1; setCount(n); if (n <= 0) { window.clearInterval(t); begin() } }, 1000)
      return
    }
    begin()
  }

  const R = 44, C = 2 * Math.PI * R, frac = Math.min(1, ms / max)
  const tools = (
    <nav className={`rc-tools ${prefs.side}`} aria-label="Camera tools">
      <button aria-label={song ? `Song: ${song.title}` : 'Add music'} onClick={() => setPanel('music')} className={song ? 'on' : ''}><Music2 size={28} /></button>
      <button aria-label="Effects" aria-pressed={panel === 'effects'} onClick={() => setPanel(p => (p === 'effects' ? null : 'effects'))} className={filter !== 'none' ? 'on' : ''}><Sparkles size={28} /></button>
      <button aria-label="Align with the last take" aria-pressed={align} disabled={!marks.length} onClick={() => setAlign(a => !a)} className={align ? 'on' : ''}><Layers size={28} /></button>
      <button aria-label="Grid" aria-pressed={prefs.grid} onClick={() => setPrefs({ grid: !prefs.grid })} className={prefs.grid ? 'on' : ''}><Grid3x3 size={28} /></button>
      <button aria-label={`Length ${prefs.duration} seconds. Change`} disabled={state !== 'idle'} onClick={() => setPrefs({ duration: ([15, 30, 60, 90] as const)[([15, 30, 60, 90].indexOf(prefs.duration) + 1) % 4] })}><span className="rc-dur">{prefs.duration}</span></button>
    </nav>
  )

  return (
    <div className="rc" role="dialog" aria-modal="true" aria-label="Reel camera">
      <div className="rc-stage">
        <video ref={video} className="rc-view" playsInline muted autoPlay style={{ filter: filterCss(filter), transform: facing === 'user' ? 'scaleX(-1)' : undefined }} />
        {align && ghost && <img className="rc-ghost" src={ghost} alt="" aria-hidden style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined }} />}
        {prefs.grid && <div className="rc-grid" aria-hidden><i /><i /><i /><i /></div>}
        {denied && <div className="rc-denied"><p>{denied}</p><button className="ms-cta" onClick={() => gallery.current?.click()}>Choose a video</button></div>}
        {count > 0 && <div className="rc-count" aria-live="assertive">{count}</div>}

        <div className="rc-progress" aria-hidden>
          <i style={{ width: `${frac * 100}%` }} />
          {marks.map(m => <b key={m} style={{ left: `${(m / max) * 100}%` }} />)}
        </div>
        <div className="rc-top">
          <button className="rc-x" aria-label="Close" onClick={() => (ms > 0 ? confirm('Discard this reel?') && onClose() : onClose())}><X size={30} /></button>
          <div className="rc-topmid">
            <div className="rc-pills">
              <button className="rc-pill" aria-label={torch ? 'Flash off' : 'Flash on'} disabled={torch === null} aria-pressed={Boolean(torch)} onClick={() => void setFlash(!torch)}>{torch ? <Zap size={22} /> : <ZapOff size={22} />}</button>
              <button className="rc-pill" aria-label={`Speed ${speed}×. Change`} disabled={state !== 'idle'} onClick={() => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s as never) + 1) % SPEEDS.length])}><b>{speed}×</b></button>
              <button className={`rc-pill${timer ? ' on' : ''}`} aria-label={timer ? `Timer ${timer} seconds. Change` : 'Timer off. Change'} onClick={() => setTimer(t => (t === 0 ? 3 : t === 3 ? 10 : 0))}>{timer ? <b>{timer}s</b> : <Timer size={22} />}</button>
            </div>
            <button className="rc-audio" onClick={() => setPanel('music')}>
              {song ? <><TrackArt path={song.artwork_path} size={22} /><span className="clamp-1">{song.title}</span></> : <><Music2 size={18} aria-hidden /> Add audio</>}
            </button>
          </div>
          <button className="rc-x" aria-label="Camera settings" onClick={() => setPanel('settings')}><Settings size={28} /></button>
        </div>
        {state === 'idle' && !ms && tools}
        {state === 'paused' && tools}

        {panel === 'effects' && (
          <div className="rc-fx" role="group" aria-label="Effects">
            {FILTERS.map(f => <button key={f.key} className={filter === f.key ? 'on' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}><span style={{ filter: f.css }} aria-hidden />{f.label}</button>)}
          </div>
        )}

        <div className="rc-shoot">
          {ms > 0 && state !== 'rec' ? <button className="rc-side" aria-label="Discard recording" onClick={discard}><Trash2 size={24} /></button> : <span className="rc-side" />}
          <button className={`rc-shutter ${state}`} disabled={!ready || count > 0} onClick={shutter} aria-label={state === 'rec' ? 'Pause recording' : ms ? 'Continue recording' : 'Start recording'}>
            <svg viewBox="0 0 100 100" aria-hidden><circle cx="50" cy="50" r={R} className="rc-ring-bg" /><circle cx="50" cy="50" r={R} className="rc-ring" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} /></svg>
            <span className="rc-core" />
          </button>
          {ms >= 1000 && state !== 'rec' ? <button className="rc-next" aria-label="Next: edit your reel" onClick={finish}><Check size={26} /></button> : <span className="rc-side" />}
        </div>
        {ms > 0 && <p className="rc-time" aria-live="off">{(ms / 1000).toFixed(1)}s / {prefs.duration}s</p>}
      </div>

      <div className="rc-bottom">
        <button className="rc-gallery" aria-label="Choose a video from your gallery" onClick={() => gallery.current?.click()} disabled={state === 'rec'}><ImagePlus size={22} /></button>
        <div className="rc-modes" role="tablist" aria-label="Create">
          <button role="tab" aria-selected={false} onClick={() => nav('/app/memories/new', { replace: true })} disabled={ms > 0}>MEMORY</button>
          <button role="tab" aria-selected className="on">REEL</button>
        </div>
        <button className="rc-flip" aria-label="Switch camera" disabled={ms > 0} onClick={() => setFacing(f => (f === 'user' ? 'environment' : 'user'))}><RefreshCw size={26} /></button>
      </div>
      <input ref={gallery} type="file" hidden accept="video/mp4,video/webm,video/quicktime" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPickFile(f) }} />

      {panel === 'music' && <MusicSheet value={song} onPick={onSong} onClose={() => setPanel(null)} title="Add audio" />}
      {panel === 'settings' && (
        <StudioSheet title="Camera settings" onClose={() => setPanel(null)} wide>
          <div className="cs">
            <h3>Controls</h3>
            <label className="cs-row"><span>Always start on front camera</span><input type="checkbox" className="shs-switch" checked={prefs.front} onChange={e => setPrefs({ front: e.target.checked })} /></label>
            <h3>Camera tools</h3>
            <p className="cs-note">Choose which side of the screen you want your camera toolbar to be on.</p>
            <div role="radiogroup" aria-label="Toolbar side">
              {(['left', 'right'] as const).map(s => <label key={s} className="cs-row"><span>{s === 'left' ? 'Left side' : 'Right side'}</span><input type="radio" name="cs-side" className="cs-radio" checked={prefs.side === s} onChange={() => setPrefs({ side: s })} /></label>)}
            </div>
            <h3>Reel length</h3>
            <div role="radiogroup" aria-label="Reel length">
              {([15, 30, 60, 90] as const).map(d => <label key={d} className="cs-row"><span>{d} seconds</span><input type="radio" name="cs-dur" className="cs-radio" disabled={state !== 'idle' || ms > 0} checked={prefs.duration === d} onChange={() => setPrefs({ duration: d })} /></label>)}
            </div>
            <h3>Composition</h3>
            <label className="cs-row"><span>Show grid</span><input type="checkbox" className="shs-switch" checked={prefs.grid} onChange={e => setPrefs({ grid: e.target.checked })} /></label>
            <button className="shs-go" onClick={() => setPanel(null)}>Done</button>
          </div>
        </StudioSheet>
      )}
    </div>
  )
}
