import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, Globe, ImagePlus, Type, Users, Video, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { MEMORY_BG, createMemory, validateMedia } from '../lib/social'
import { playSound } from '../lib/sounds'
import { errMsg, toast } from '../ui'

/** Share a memory: a photo, a video or a text card. Lives 24 hours for friends or everyone; you can keep it as a highlight. */
export default function MemoryCreate() {
  const { uid } = useAuth()
  const nav = useNavigate()
  const [mode, setMode] = useState<'media' | 'text'>('media')
  const [file, setFile] = useState<{ file: File; url: string; kind: 'photo' | 'video' } | null>(null)
  const [text, setText] = useState('')
  const [bg, setBg] = useState('violet')
  const [visibility, setVisibility] = useState<'friends' | 'public'>('friends')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const gallery = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null), recorder = useRef<HTMLInputElement>(null)
  useEffect(() => { document.title = 'Share a memory · VYBE' }, [])
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url) }, [file])

  const pick = (f?: File) => {
    if (!f) return
    const c = validateMedia(f)
    if (!c.ok) return setErr(c.error)
    setErr(''); setFile({ file: f, url: URL.createObjectURL(f), kind: c.type === 'video' ? 'video' : 'photo' })
  }
  const ready = mode === 'media' ? Boolean(file) : text.trim().length > 0
  const share = async () => {
    if (!ready || busy || !uid) return
    setBusy(true); setErr('')
    try {
      await createMemory(uid, mode === 'text' ? { kind: 'text', text, bg, visibility } : { kind: file!.kind, file: file!.file, text, visibility })
      playSound('send'); toast('Memory shared'); nav('/app', { replace: true })
    } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <div className="cp mem-create" role="dialog" aria-modal="true" aria-label="Share a memory">
      <header className="cp-head">
        <button className="icon-btn" aria-label="Close" onClick={() => nav(-1)}><X size={26} /></button>
        <h1 className="cp-title">Share a memory</h1>
        <button className="cp-post" disabled={!ready || busy} onClick={share}>{busy ? 'Sharing…' : 'Share'}</button>
      </header>
      <div className="cp-body">
        <div className="cp-tabs" role="tablist" aria-label="Memory type">
          <button role="tab" aria-selected={mode === 'media'} className={`cp-tab${mode === 'media' ? ' on' : ''}`} onClick={() => setMode('media')}><ImagePlus size={16} aria-hidden /> Photo or video</button>
          <button role="tab" aria-selected={mode === 'text'} className={`cp-tab${mode === 'text' ? ' on' : ''}`} onClick={() => setMode('text')}><Type size={16} aria-hidden /> Text</button>
        </div>
        {mode === 'media' ? (
          <>
            <div className="mem-stage">
              {file ? (
                <>{file.kind === 'video' ? <video src={file.url} controls playsInline muted /> : <img src={file.url} alt="Your memory preview" />}
                  <button className="cp-rm" aria-label="Remove" onClick={() => setFile(null)}><X size={16} /></button></>
              ) : (
                <div className="mem-empty">
                  <p>Pick something from your gallery or capture it now.</p>
                  <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button className="btn primary" onClick={() => gallery.current?.click()}><ImagePlus size={18} aria-hidden /> Gallery</button>
                    <button className="btn" onClick={() => camera.current?.click()}><Camera size={18} aria-hidden /> Camera</button>
                    <button className="btn" onClick={() => recorder.current?.click()}><Video size={18} aria-hidden /> Record</button>
                  </div>
                </div>
              )}
            </div>
            <textarea className="textarea" aria-label="Caption (optional)" placeholder="Add a caption (optional)" value={text} maxLength={500} onChange={e => setText(e.target.value)} style={{ marginTop: 12, minHeight: 64 }} />
          </>
        ) : (
          <>
            <div className="mem-stage mem-text" style={{ background: MEMORY_BG[bg] }}>
              <textarea aria-label="Your memory" placeholder="Start typing" value={text} maxLength={500} onChange={e => setText(e.target.value)} autoFocus />
            </div>
            <div className="chips" role="group" aria-label="Background" style={{ marginTop: 12 }}>
              {Object.keys(MEMORY_BG).map(k => <button key={k} className="mem-swatch" aria-pressed={bg === k} aria-label={`Background ${k}`} onClick={() => setBg(k)} style={{ background: MEMORY_BG[k] }} />)}
            </div>
          </>
        )}
        <div className="mem-aud" role="group" aria-label="Who can see this">
          <button className={`cp-opt${visibility === 'friends' ? ' on' : ''}`} aria-pressed={visibility === 'friends'} onClick={() => setVisibility('friends')}><Users size={22} aria-hidden /><span className="grow"><b>Friends</b><span className="t-meta" style={{ display: 'block' }}>Only your friends</span></span></button>
          <button className={`cp-opt${visibility === 'public' ? ' on' : ''}`} aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}><Globe size={22} aria-hidden /><span className="grow"><b>Public</b><span className="t-meta" style={{ display: 'block' }}>Anyone on VYBE</span></span></button>
        </div>
        <p className="t-meta" style={{ marginTop: 12 }}>Memories disappear from everyone’s view after 24 hours. You keep them in your archive and can turn any into a highlight.</p>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
      <input ref={gallery} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={recorder} type="file" hidden accept="video/*" capture="environment" onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}
