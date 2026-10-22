import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Clapperboard, Globe, Users, Video } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import { discardUploads, uploadMedia, validateMedia, MAX_VIDEO_BYTES } from '../lib/media'
import { makeThumb, registerAsset, uploadThumb, type Thumb } from '../lib/library'
import { isMissingSchema } from '../lib/tickets'
import { playSound } from '../lib/sounds'
import { errMsg, toast } from '../ui'

/**
 * Make a reel: pick or record one video, see it as it will look (vertical), write a caption, post. The upload starts the
 * moment the video is chosen and runs while you write; Post waits for it. A still from the video becomes its poster.
 */
export default function ReelCreate() {
  const { uid } = useAuth()
  const nav = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [pct, setPct] = useState(0)
  const [up, setUp] = useState<{ path: string } | null>(null)
  const [failed, setFailed] = useState('')
  const [caption, setCaption] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [busy, setBusy] = useState(false)
  const job = useRef<{ ctrl: AbortController; promise: Promise<{ path: string }>; still: Promise<{ thumb: Thumb | null; path: string | null }> } | null>(null)
  const posted = useRef(false)
  const pick = useRef<HTMLInputElement>(null), record = useRef<HTMLInputElement>(null)
  useEffect(() => { document.title = 'New reel · VYBE' }, [])
  // Leaving without posting cancels the upload and removes anything already uploaded.
  useEffect(() => () => {
    const j = job.current; if (!j || posted.current) return
    j.ctrl.abort()
    void j.promise.then(r => discardUploads('media', [r.path]), () => {})
    void j.still.then(s => discardUploads('media', [s.path]))
  }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  const choose = (f?: File) => {
    if (!f || !uid) return
    const c = validateMedia(f)
    if (!c.ok) return toast(c.error)
    if (c.type !== 'video') return toast('A reel is a video. Choose a video file.')
    if (job.current) { job.current.ctrl.abort(); void job.current.promise.then(r => discardUploads('media', [r.path]), () => {}) }
    setFile(f); setUrl(URL.createObjectURL(f)); setPct(0); setUp(null); setFailed('')
    const ctrl = new AbortController()
    const promise = uploadMedia(uid, f, { signal: ctrl.signal, first: true, onProgress: (s, t) => setPct(Math.round((s / t) * 100)) })
    const still = makeThumb(f).then(async thumb => ({ thumb, path: thumb ? await uploadThumb(uid, thumb, ctrl.signal).catch(() => null) : null })).catch(() => ({ thumb: null, path: null }))
    job.current = { ctrl, promise, still }
    promise.then(r => setUp(r), e => { if (!ctrl.signal.aborted) setFailed(errMsg(e)) })
  }

  const post = async () => {
    const j = job.current; if (!j || !file || !uid || busy) return
    setBusy(true)
    try {
      const r = await j.promise
      const s = await j.still
      const ins = await supabase.from('posts').insert({ author: uid, body: caption.trim(), media_path: r.path, media_type: 'video', visibility, is_reel: true }).select('id').single()
      if (ins.error) throw new Error(isMissingSchema(ins.error) ? 'Reels need the latest database update.' : ins.error.message)
      const pm = await supabase.from('post_media').insert({ post_id: ins.data.id, sort: 0, path: r.path, type: 'video', ...(s.path ? { poster_path: s.path } : {}) })
      if (pm.error) await supabase.from('post_media').insert({ post_id: ins.data.id, sort: 0, path: r.path, type: 'video' })
      posted.current = true
      void registerAsset({ path: r.path, kind: 'video', mime: file.type, bytes: file.size, thumb: s.thumb, thumb_path: s.path, title: caption.trim().slice(0, 120) || 'Reel' }).catch(() => {})
      playSound('send'); toast('Reel shared')
      nav('/app/reels', { replace: true })
    } catch (e) { toast(errMsg(e)); setBusy(false) }
  }

  return (
    <div className="reel-new" role="dialog" aria-modal="true" aria-label="New reel">
      <header className="cp-head">
        <button className="icon-btn" aria-label="Close" onClick={() => nav(-1)}><ArrowLeft size={24} /></button>
        <h1 className="cp-title">New reel</h1>
        <button className="btn primary sm" disabled={!file || busy || Boolean(failed)} onClick={() => void post()}>{busy ? (up ? 'Posting…' : `${pct}%`) : 'Share'}</button>
      </header>
      <div className="reel-new-body">
        <div className="reel-new-preview">
          {url ? <video src={url} autoPlay muted loop playsInline aria-label="Preview of your reel" />
            : <div className="reel-new-empty"><Clapperboard size={40} aria-hidden /><p>Vertical videos look best. Up to {MAX_VIDEO_BYTES / 1024 / 1024} MB.</p></div>}
          {file && !up && !failed && <progress className="cp-prog reel-new-prog" max={100} value={pct} aria-label="Upload progress" />}
          {failed && <p className="error reel-new-fail" role="alert">Not uploaded: {failed} <button className="btn sm" onClick={() => choose(file!)}>Retry</button></p>}
        </div>
        <div className="reel-new-form">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => pick.current?.click()}><Clapperboard size={18} aria-hidden /> {file ? 'Choose another' : 'Choose a video'}</button>
            <button className="btn" onClick={() => record.current?.click()}><Video size={18} aria-hidden /> Record</button>
            <input ref={pick} type="file" accept="video/mp4,video/webm,video/quicktime" className="sr-only" aria-label="Choose a video for your reel" onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={record} type="file" accept="video/*" capture="environment" className="sr-only" aria-label="Record a video for your reel" onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
          </div>
          <label className="field"><span>Caption</span><textarea className="textarea" value={caption} maxLength={2200} placeholder="Say something about it…" onChange={e => setCaption(e.target.value)} /></label>
          <div className="seg" role="group" aria-label="Who can see it">
            <button className="chip" aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}><Globe size={14} aria-hidden /> Everyone</button>
            <button className="chip" aria-pressed={visibility === 'friends'} onClick={() => setVisibility('friends')}><Users size={14} aria-hidden /> Friends</button>
          </div>
          {file && <p className="t-meta" role="status">{up ? 'Uploaded. Ready to share.' : failed ? '' : `Uploading ${pct}%… you can keep writing.`}</p>}
        </div>
      </div>
    </div>
  )
}
