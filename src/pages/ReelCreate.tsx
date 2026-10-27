import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Film, Gauge, Globe, ImageIcon, Music2, Scissors, Sparkles, Users, Volume2 } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import { publish } from '../lib/publisher'
import { fetchPosts } from '../lib/posts'
import { discardUploads, uploadMedia, uploadSong, validateMedia, MAX_VIDEO_BYTES } from '../lib/media'
import { makeThumb, registerAsset, uploadThumb } from '../lib/library'
import { createMemory } from '../lib/social'
import { FILTERS, SPEEDS, filterCss, fmtMs, songUrl, useSongPlayer, type FilterKey, type ReelEdit, type StudioSong } from '../lib/studio'
import { isMissingSchema } from '../lib/tickets'
import { playSound } from '../lib/sounds'
import { ReelCamera } from '../components/studio/ReelCamera'
import { MusicSheet } from '../components/studio/MusicSheet'
import { TrackArt } from './create/pickers'
import { errMsg, toast } from '../ui'
import { attachSmallCopy } from '../lib/videoCopyAttach'
import { currentPolicy } from '../lib/dataMode'

type Step = 'camera' | 'edit' | 'details'
type Panel = 'music' | 'volume' | 'effects' | 'speed' | 'trim' | 'cover' | null

/**
 * Make a reel: record in takes (or pick a video), then edit — song and where it starts, original/music volume, effects,
 * speed, trim and cover — and share with a caption. The upload starts the moment the video exists and runs while you edit;
 * the edits are saved as playback settings next to the untouched original, so nothing is re-encoded or lost.
 */
export default function ReelCreate() {
  const { uid } = useAuth()
  const nav = useNavigate()
  const loc = useLocation() as { state?: { song?: StudioSong } }
  const [step, setStep] = useState<Step>('camera')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [pct, setPct] = useState(0)
  const [up, setUp] = useState<{ path: string } | null>(null)
  const [failed, setFailed] = useState('')
  const [caption, setCaption] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [toMemory, setToMemory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [song, setSong] = useState<StudioSong | null>(loc.state?.song ?? null)
  const [filter, setFilter] = useState<FilterKey>('none')
  const [speed, setSpeed] = useState(1)
  const [ov, setOv] = useState(1)
  const [mv, setMv] = useState(0.9)
  const [dur, setDur] = useState(0)
  const [trim, setTrim] = useState<[number, number]>([0, 0])
  const [cover, setCover] = useState(0)
  const [panel, setPanel] = useState<Panel>(null)
  const job = useRef<{ ctrl: AbortController; promise: Promise<{ path: string }> } | null>(null)
  const posted = useRef(false)
  const vid = useRef<HTMLVideoElement>(null)
  useEffect(() => { document.title = 'New reel · VYBE' }, [])
  useEffect(() => { const t = new URLSearchParams(window.location.search).get('track'); if (!t || song) return
    void supabase.from('music_tracks').select('id,title,artist,preview_path,artwork_path').eq('id', t).maybeSingle().then(({ data }) => { if (data) setSong({ track_id: data.id, title: data.title, artist: data.artist, preview_path: data.preview_path, artwork_path: data.artwork_path, start_ms: 0 }) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving without posting cancels the upload and removes anything already uploaded.
  useEffect(() => () => {
    const j = job.current; if (!j || posted.current) return
    j.ctrl.abort(); void j.promise.then(r => discardUploads('media', [r.path]), () => {})
  }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  const choose = (f: File, opts: { speed?: number; filter?: FilterKey } = {}) => {
    if (!uid) return
    const c = validateMedia(f)
    if (!c.ok) return toast(c.error)
    if (c.type !== 'video') return toast('A reel is a video. Choose a video file.')
    if (job.current) { job.current.ctrl.abort(); void job.current.promise.then(r => discardUploads('media', [r.path]), () => {}) }
    setFile(f); setUrl(URL.createObjectURL(f)); setPct(0); setUp(null); setFailed(''); setDur(0); setTrim([0, 0]); setCover(0)
    setSpeed(opts.speed ?? 1); setFilter(opts.filter ?? 'none'); setStep('edit')
    const ctrl = new AbortController()
    const promise = uploadMedia(uid, f, { signal: ctrl.signal, first: true, onProgress: (s, t) => setPct(Math.round((s / t) * 100)) })
    job.current = { ctrl, promise }
    promise.then(r => setUp(r), e => { if (!ctrl.signal.aborted) setFailed(errMsg(e)) })
  }

  // Preview plays exactly as viewers will see it: speed, trim loop, effect, both volumes.
  const [songLocal, setSongLocal] = useState<string | null>(null)
  const [songSrc, setSongSrc] = useState<string | null>(null)
  useEffect(() => { const u = song?.file ? URL.createObjectURL(song.file) : null; setSongLocal(u); return () => { if (u) URL.revokeObjectURL(u) } }, [song?.file])
  useEffect(() => { let live = true; if (!song) { setSongSrc(null); return } void songUrl(song, songLocal).then(u => live && setSongSrc(u)); return () => { live = false } }, [song, songLocal])
  const end = trim[1] || dur
  const music = useSongPlayer(songSrc, { playing: step !== 'camera' && panel !== 'music', start_ms: song?.start_ms ?? 0, clip_ms: Math.max(1000, (end - trim[0]) / speed), volume: mv })
  useEffect(() => { const v = vid.current; if (v) { v.playbackRate = speed; v.volume = ov; v.muted = ov === 0 } }, [speed, ov, url, step])
  const onTime = () => {
    const v = vid.current; if (!v) return
    if (panel === 'cover') return
    if (end && v.currentTime * 1000 >= end) { v.currentTime = trim[0] / 1000; music.restart() }
  }
  useEffect(() => { const v = vid.current; if (v && panel !== 'cover') { v.currentTime = trim[0] / 1000; void v.play().catch(() => {}) } }, [trim[0]]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const v = vid.current; if (!v) return; if (panel === 'cover') { v.pause(); v.currentTime = cover / 1000 } else void v.play().catch(() => {}) }, [panel, cover])

  // Share and go straight back: the reel finishes in the background (lib/publisher) with a progress strip and Retry.
  const post = () => {
    const j = job.current; if (!j || !file || !uid || busy) return
    setBusy(true)
    posted.current = true                                   // leaving now must not cancel or delete the upload
    const me = uid, f = file, picked = song, at = cover / 1000, text = caption.trim(), vis = visibility, alsoMemory = toMemory, fx = filter
    const edit: ReelEdit = {
      ...(filter !== 'none' ? { filter } : {}), ...(speed !== 1 ? { speed } : {}), ...(trim[0] > 0 || (trim[1] && trim[1] < dur) ? { trim: [trim[0], end] as [number, number] } : {}),
      ...(ov !== 1 ? { ov } : {}), ...(song ? { mv, ms: song.start_ms } : {}),
    }
    let songPath: string | null = null, stillPath: string | null = null, savedId: string | null = null, thumbUsed: Awaited<ReturnType<typeof makeThumb>> | null = null
    let upload = j.promise
    publish('reel', 'reel', null, async report => {
      if (!savedId) {
        let r: { path: string }
        try { r = await upload } catch { upload = uploadMedia(me, f, { onProgress: v => report(Math.min(0.9, v / f.size)) }); r = await upload }
        if (!stillPath) { thumbUsed = await makeThumb(f, { at }).catch(() => null); stillPath = thumbUsed ? await uploadThumb(me, thumbUsed).catch(() => null) : null }
        if (picked?.file && !songPath) songPath = await uploadSong(me, picked.file)
        report(0.95)
        const base = {
          author: me, body: text, media_path: r.path, media_type: 'video', visibility: vis, is_reel: true,
          ...(picked ? { music_track_id: picked.track_id ?? null, music_title: picked.title.slice(0, 120), music_artist: picked.artist.slice(0, 120), ...(songPath ? { music_path: songPath } : {}) } : {}),
        }
        let ins = await supabase.from('posts').insert({ ...base, ...(Object.keys(edit).length ? { reel_edit: edit } : {}) }).select('id').single()
        if (ins.error && isMissingSchema(ins.error) && Object.keys(edit).length) ins = await supabase.from('posts').insert(base).select('id').single()
        if (ins.error) throw new Error(isMissingSchema(ins.error) ? 'Reels need the latest database update.' : ins.error.message)
        const pm = await supabase.from('post_media').insert({ post_id: ins.data.id, sort: 0, path: r.path, type: 'video', ...(stillPath ? { poster_path: stillPath } : {}) })
        if (pm.error) await supabase.from('post_media').insert({ post_id: ins.data.id, sort: 0, path: r.path, type: 'video' })
        savedId = ins.data.id as string
        // The smaller copy for slow connections, made after publishing (lib/videoCopy); never blocks the reel.
        if (!currentPolicy().lowEnd) void attachSmallCopy(me, f, savedId, 0)
        void registerAsset({ path: r.path, kind: 'video', mime: f.type, bytes: f.size, thumb: thumbUsed, thumb_path: stillPath, title: text.slice(0, 120) || 'Reel' }).catch(() => {})
        if (alsoMemory) await createMemory(me, { kind: 'video', reuse_path: r.path, text, visibility: vis, filter: fx, song: picked ? { track_id: picked.track_id, title: picked.title, artist: picked.artist, start_ms: picked.start_ms } : null }).catch(e => toast(`Reel shared; the memory was not: ${errMsg(e)}`))
        playSound('share')
      }
      return fetchPosts({ uid: me, ids: [savedId] }).then(x => x[0] ?? null, () => null)
    }, { onDiscard: () => { void upload.then(r => discardUploads('media', [r.path]), () => {}); discardUploads('media', [songPath, stillPath]) } })
    nav('/app', { replace: true })
  }

  if (step === 'camera') return (
    <ReelCamera song={song} onSong={setSong} onClose={() => nav(-1)} onPickFile={f => choose(f)} onTake={t => choose(t.file, { speed: t.speed, filter: t.filter })} />
  )

  const tools: { key: Exclude<Panel, null>; label: string; icon: React.ReactNode }[] = [
    { key: 'music', label: 'Audio', icon: <Music2 size={22} /> }, { key: 'volume', label: 'Volume', icon: <Volume2 size={22} /> },
    { key: 'effects', label: 'Effects', icon: <Sparkles size={22} /> }, { key: 'speed', label: 'Speed', icon: <Gauge size={22} /> },
    { key: 'trim', label: 'Trim', icon: <Scissors size={22} /> }, { key: 'cover', label: 'Cover', icon: <ImageIcon size={22} /> },
  ]
  const progress = file && !up && !failed

  return (
    <div className="re" role="dialog" aria-modal="true" aria-label={step === 'edit' ? 'Edit your reel' : 'Share your reel'}>
      <header className="re-head">
        <button className="rc-x" aria-label="Back" onClick={() => (step === 'details' ? setStep('edit') : confirm('Discard this video and go back to the camera?') && setStep('camera'))}><ArrowLeft size={26} /></button>
        <h1>{step === 'edit' ? 'Edit' : 'New reel'}</h1>
        {step === 'edit'
          ? <button className="re-next" onClick={() => { setPanel(null); setStep('details') }}>Next</button>
          : <button className="re-next" disabled={busy || Boolean(failed)} onClick={() => void post()}>{busy ? (up ? 'Sharing…' : `${pct}%`) : 'Share'}</button>}
      </header>

      <div className={`re-body ${step}`}>
        <div className="re-preview">
          {url && <video ref={vid} src={url} autoPlay loop playsInline onTimeUpdate={onTime} onLoadedMetadata={e => { const d = Math.round(e.currentTarget.duration * 1000) || 0; setDur(d); setTrim(t => (t[1] ? t : [0, d])) }} style={{ filter: filterCss(filter) }} aria-label="Preview of your reel" />}
          {song && step === 'edit' && <button className="re-song" onClick={() => setPanel('music')}><TrackArt path={song.artwork_path} size={24} /><span className="clamp-1">{song.title} · {song.artist}</span></button>}
          {progress && <progress className="cp-prog reel-new-prog" max={100} value={pct} aria-label="Upload progress" />}
          {failed && <p className="error reel-new-fail" role="alert">Not uploaded: {failed} <button className="btn sm" onClick={() => choose(file!, { speed, filter })}>Retry</button></p>}
          {music.blocked && song && <button className="mst-tapsound" onClick={music.unblock}><Volume2 size={16} aria-hidden /> Tap for sound</button>}
        </div>

        {step === 'edit' ? (
          <div className="re-tools">
            {panel && panel !== 'music' && (
              <div className="re-panel">
                {panel === 'volume' && (<>
                  <label className="re-slider"><span>Original audio</span><input type="range" min={0} max={1} step={0.05} value={ov} onChange={e => setOv(Number(e.target.value))} /><b>{Math.round(ov * 100)}</b></label>
                  <label className="re-slider"><span>Song</span><input type="range" min={0} max={1} step={0.05} value={mv} disabled={!song} onChange={e => setMv(Number(e.target.value))} /><b>{song ? Math.round(mv * 100) : '—'}</b></label>
                </>)}
                {panel === 'effects' && <div className="rc-fx inline" role="group" aria-label="Effects">{FILTERS.map(f => <button key={f.key} className={filter === f.key ? 'on' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}><span style={{ filter: f.css }} aria-hidden />{f.label}</button>)}</div>}
                {panel === 'speed' && <div className="re-seg" role="radiogroup" aria-label="Speed">{SPEEDS.map(s => <button key={s} role="radio" aria-checked={speed === s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>)}</div>}
                {panel === 'trim' && (<>
                  <label className="re-slider"><span>Start</span><input type="range" min={0} max={Math.max(0, end - 1000)} step={100} value={trim[0]} onChange={e => setTrim([Math.min(Number(e.target.value), end - 1000), trim[1]])} /><b>{fmtMs(trim[0])}</b></label>
                  <label className="re-slider"><span>End</span><input type="range" min={Math.min(dur, trim[0] + 1000)} max={dur} step={100} value={end} onChange={e => setTrim([trim[0], Math.max(Number(e.target.value), trim[0] + 1000)])} /><b>{fmtMs(end)}</b></label>
                  <p className="re-note">Plays {fmtMs((end - trim[0]) / speed)} of {fmtMs(dur)}</p>
                </>)}
                {panel === 'cover' && (<>
                  <label className="re-slider"><span>Frame</span><input type="range" min={0} max={Math.max(0, dur - 100)} step={50} value={cover} onChange={e => setCover(Number(e.target.value))} /><b>{fmtMs(cover)}</b></label>
                  <p className="re-note">This frame shows before the reel plays.</p>
                </>)}
              </div>
            )}
            <div className="re-toolbar" role="toolbar" aria-label="Edit tools">
              {tools.map(t => <button key={t.key} className={panel === t.key ? 'on' : ''} aria-pressed={panel === t.key} onClick={() => setPanel(p => (p === t.key ? null : t.key))}>{t.icon}<span>{t.label}</span></button>)}
            </div>
          </div>
        ) : (
          <div className="re-details">
            <label className="re-field"><span className="sr-only">Caption</span><textarea value={caption} maxLength={2200} placeholder="Write a caption… add #hashtags or @mentions" onChange={e => setCaption(e.target.value)} /></label>
            <div className="re-rows">
              <div className="re-row"><Users size={20} aria-hidden /><span className="grow">Who can watch</span>
                <div className="re-seg sm" role="radiogroup" aria-label="Who can watch">
                  <button role="radio" aria-checked={visibility === 'public'} className={visibility === 'public' ? 'on' : ''} onClick={() => setVisibility('public')}><Globe size={14} aria-hidden /> Everyone</button>
                  <button role="radio" aria-checked={visibility === 'friends'} className={visibility === 'friends' ? 'on' : ''} onClick={() => setVisibility('friends')}><Users size={14} aria-hidden /> Friends</button>
                </div></div>
              <label className="re-row"><Film size={20} aria-hidden /><span className="grow">Also share to your memory<small>For 24 hours, with the same audience</small></span><input type="checkbox" className="shs-switch" checked={toMemory} onChange={e => setToMemory(e.target.checked)} /></label>
              {song && <div className="re-row"><Music2 size={20} aria-hidden /><span className="grow clamp-1">{song.title} · {song.artist}</span></div>}
            </div>
            <p className="t-meta" role="status">{up ? 'Uploaded. Ready to share.' : failed ? '' : `Uploading ${pct}%… you can keep writing. Up to ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`}</p>
          </div>
        )}
      </div>
      {panel === 'music' && <MusicSheet value={song} onPick={setSong} onClose={() => setPanel(null)} title="Add audio" />}
    </div>
  )
}
