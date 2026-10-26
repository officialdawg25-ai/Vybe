import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Check, FolderOpen, Music2, Pause, Play, Search, X } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { brandUrl, musicCatalog, setTrackSaved, type Track } from '../../lib/social'
import { titleFromFile, validateSong } from '../../lib/media'
import { CLIP_MS, fmtMs, songUrl, useSongPlayer, type StudioSong } from '../../lib/studio'
import { useAsync } from '../../lib/hooks'
import { TrackArt } from '../../pages/create/pickers'
import { Spinner, errMsg, toast } from '../../ui'

type Tab = 'foryou' | 'trending' | 'saved' | 'device'
const TABS: [Tab, string][] = [['foryou', 'For you'], ['trending', 'Trending'], ['saved', 'Saved'], ['device', 'From device']]

/**
 * Add music: search the VYBE library (For you, Trending, Saved) or use a song from the device, then choose which 15
 * seconds play. Previews play inline; a bookmark saves a song for later. Nothing is uploaded until the post is shared.
 */
export function MusicSheet({ value, onPick, onClose, title = 'Add music', clipMs = CLIP_MS }: { value: StudioSong | null; onPick: (s: StudioSong | null) => void; onClose: () => void; title?: string; clipMs?: number }) {
  const { uid } = useAuth()
  const [tab, setTab] = useState<Tab>('foryou')
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [chosen, setChosen] = useState<StudioSong | null>(value)
  const [trim, setTrim] = useState(Boolean(value))
  const [preview, setPreview] = useState<string | null>(null)
  const device = useRef<HTMLInputElement>(null)
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 280); return () => clearTimeout(t) }, [q])
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])
  const list = useAsync(() => (tab === 'device' ? Promise.resolve([] as Track[]) : musicCatalog(tab, dq)), [tab, dq])
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const isSaved = (t: Track) => saved[t.id] ?? t.saved
  const save = async (t: Track) => {
    const on = !isSaved(t); setSaved(s => ({ ...s, [t.id]: on }))
    try { await setTrackSaved(t.id, uid!, on); toast(on ? 'Saved to your music' : 'Removed from saved') } catch (e) { setSaved(s => ({ ...s, [t.id]: !on })); toast(errMsg(e)) }
  }
  // One preview at a time, from the list.
  const previewTrack = useMemo(() => (list.data ?? []).find(t => t.id === preview) ?? null, [list.data, preview])
  useSongPlayer(previewTrack?.preview_path ? brandUrl(previewTrack.preview_path) : null, { playing: Boolean(previewTrack) && !trim, start_ms: 0, clip_ms: 30000 })
  const pickTrack = (t: Track) => { setPreview(null); setChosen({ track_id: t.id, title: t.title, artist: t.artist, preview_path: t.preview_path, artwork_path: t.artwork_path, duration_ms: t.duration_ms ?? null, start_ms: 0 }); setTrim(true) }
  const pickFile = (f?: File) => {
    if (!f) return
    const bad = validateSong(f); if (bad) return toast(bad)
    setChosen({ title: titleFromFile(f.name) || 'My music', artist: 'From my device', file: f, start_ms: 0 }); setTrim(true)
  }

  return (
    <div className="ms" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ms-panel">
        <div className="ms-grab" aria-hidden />
        <header className="ms-head">
          <button className="ms-x" aria-label="Close music" onClick={onClose}><X size={24} /></button>
          <h2>{trim && chosen ? 'Choose the moment' : title}</h2>
          {value ? <button className="ms-link" onClick={() => { onPick(null); onClose() }}>Remove</button> : <span style={{ width: 44 }} />}
        </header>
        {trim && chosen ? <ClipPicker song={chosen} clipMs={clipMs} onBack={() => setTrim(false)} onDone={s => { onPick(s); onClose() }} /> : (
          <>
            <label className="ms-search"><Search size={20} aria-hidden /><input type="search" aria-label="Search music" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} autoComplete="off" /></label>
            <div className="ms-chips" role="tablist" aria-label="Music lists">
              {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`ms-chip${tab === k ? ' on' : ''}`} onClick={() => { setTab(k); setPreview(null) }}>{l}</button>)}
            </div>
            <input ref={device} type="file" hidden accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac" onChange={e => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
            <div className="ms-body">
              {tab === 'device' ? (
                <div className="ms-device">
                  <span className="ms-device-ico" aria-hidden><FolderOpen size={30} /></span>
                  <h3>Use a song from your device</h3>
                  <p>MP3, M4A, AAC, WAV, OGG, FLAC or OPUS, up to 50 MB. It stays private to the people who can see what you share.</p>
                  <button className="ms-cta" onClick={() => device.current?.click()}>Browse files</button>
                  <p className="ms-fine">Only share music you own or have the right to share.</p>
                </div>
              ) : list.loading && !list.data ? <div className="ms-pad"><Spinner /></div>
                : list.error ? <p className="ms-pad error" role="alert">{list.error}</p>
                : !list.data?.length ? (
                  <div className="ms-device">
                    <span className="ms-device-ico" aria-hidden><Music2 size={30} /></span>
                    <h3>{list.data === null ? 'Music needs the latest update' : tab === 'saved' ? 'No saved songs yet' : dq ? `Nothing matches “${dq}”` : 'The library is empty for now'}</h3>
                    <p>{tab === 'saved' ? 'Tap the bookmark on any song to keep it here.' : 'You can still use a song from your device.'}</p>
                    <button className="ms-cta" onClick={() => setTab('device')}>From device</button>
                  </div>
                ) : (
                  <ul className="ms-list">{list.data.map(t => (
                    <li key={t.id} className={`ms-row${chosen?.track_id === t.id ? ' on' : ''}`}>
                      <button className="ms-art" aria-label={preview === t.id ? `Stop preview of ${t.title}` : `Preview ${t.title}`} disabled={!t.preview_path} onClick={() => setPreview(p => (p === t.id ? null : t.id))}>
                        <TrackArt path={t.artwork_path} size={56} />
                        {t.preview_path && <span className="ms-art-play" aria-hidden>{preview === t.id ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</span>}
                      </button>
                      <button className="ms-pick" onClick={() => pickTrack(t)} aria-label={`Use ${t.title} by ${t.artist}`}>
                        <span className="ms-title clamp-1">{t.title}{t.genre && <span className="ms-tag">{t.genre}</span>}</span>
                        <span className="ms-sub clamp-1">{t.artist}{t.duration_ms ? ` • ${fmtMs(t.duration_ms)}` : ''}</span>
                      </button>
                      {chosen?.track_id === t.id && <Check size={20} aria-label="Selected" className="ms-check" />}
                      <button className={`ms-save${isSaved(t) ? ' on' : ''}`} aria-pressed={isSaved(t)} aria-label={isSaved(t) ? `Remove ${t.title} from saved` : `Save ${t.title}`} onClick={() => void save(t)}><Bookmark size={26} fill={isSaved(t) ? 'currentColor' : 'none'} /></button>
                    </li>))}</ul>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Pick the moment of the song that plays: drag the bright window along the waveform (or use the slider, or the arrow keys
 * on it). The window is exactly as long as the memory or post plays, and the chosen stretch loops while you choose.
 */
function ClipPicker({ song, clipMs, onBack, onDone }: { song: StudioSong; clipMs: number; onBack: () => void; onDone: (s: StudioSong) => void }) {
  const [local] = useState(() => (song.file ? URL.createObjectURL(song.file) : null))
  useEffect(() => () => { if (local) URL.revokeObjectURL(local) }, [local])
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => { let live = true; void songUrl(song, local).then(u => live && setSrc(u)); return () => { live = false } }, [song, local])
  const [dur, setDur] = useState(song.duration_ms ?? 0)
  const [start, setStart] = useState(song.start_ms)
  const clip = dur ? Math.min(clipMs, dur) : clipMs
  const p = useSongPlayer(src, { playing: true, start_ms: start, clip_ms: clip })
  useEffect(() => { const a = p.audio.current; if (!a) return; const on = () => Number.isFinite(a.duration) && a.duration > 0 && setDur(Math.round(a.duration * 1000)); a.addEventListener('loadedmetadata', on); on(); return () => a.removeEventListener('loadedmetadata', on) }, [src]) // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(0, dur - clip)
  const at = Math.min(start, max)
  const bars = useMemo(() => Array.from({ length: 64 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7 + (song.title.length % 7)) * Math.cos(i * 0.37))), [song.title])
  const win = dur ? Math.min(1, clip / dur) : 1, left = dur ? at / dur : 0
  const prog = dur ? Math.min(1, Math.max(0, (p.pos * 1000 - at) / clip)) : 0
  // Dragging the window: the finger's movement across the waveform moves the start by the same share of the song.
  const wave = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; from: number } | null>(null)
  const move = (clientX: number) => {
    const d = drag.current, el = wave.current; if (!d || !el || !dur) return
    const next = d.from + ((clientX - d.x) / el.clientWidth) * dur
    setStart(Math.round(Math.min(max, Math.max(0, next)) / 250) * 250)
  }
  return (
    <div className="ms-clip">
      <div className="ms-clip-card">
        <TrackArt path={song.artwork_path} size={112} />
        <h3 className="clamp-2">{song.title}</h3>
        <p className="clamp-1">{song.artist}</p>
        {p.blocked && <button className="ms-cta" onClick={p.unblock}><Play size={16} fill="currentColor" aria-hidden /> Play</button>}
      </div>
      <div ref={wave} className={`ms-wave${max ? ' can' : ''}`} aria-hidden
        onPointerDown={e => { if (!max) return; drag.current = { x: e.clientX, from: at }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => move(e.clientX)}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        {bars.map((h, i) => <i key={i} style={{ height: `${h * 100}%`, opacity: i / bars.length >= left && i / bars.length <= left + win ? 1 : 0.35 }} />)}
        <span className="ms-win" style={{ left: `${left * 100}%`, width: `${win * 100}%` }}><b style={{ width: `${prog * 100}%` }} /></span>
      </div>
      <label className="ms-range">
        <span className="sr-only">Song starts at</span>
        <input type="range" min={0} max={max || 0} step={250} value={at} disabled={!max} onChange={e => setStart(Number(e.target.value))} aria-valuetext={`Starts at ${fmtMs(at)}`} />
      </label>
      <p className="ms-time">{fmtMs(at)} – {fmtMs(at + clip)}{dur ? ` of ${fmtMs(dur)}` : ''} · {Math.round(clip / 1000)} s</p>
      <div className="ms-clip-act">
        <button className="ms-ghost" onClick={onBack}>Back to songs</button>
        <button className="ms-cta" onClick={() => onDone({ ...song, duration_ms: dur || song.duration_ms, start_ms: at })}>Done</button>
      </div>
    </div>
  )
}
