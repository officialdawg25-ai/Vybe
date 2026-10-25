import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, AtSign, ChevronRight, ChevronUp, Download, Camera, Clapperboard, ImagePlus, MoreHorizontal, Music2, PenLine, Smile, Sparkles, Star, Type, Volume2, VolumeX, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { MEMORY_BG, createMemory, validateMedia } from '../lib/social'
import { FILTERS, filterCss, downloadBlob, newId, renderStill, songUrl, useSongPlayer, type FilterKey, type Overlay, type StudioSong, type TextOverlay } from '../lib/studio'
import { supabase } from '../lib/supabase'
import { playSound } from '../lib/sounds'
import { CameraCapture } from '../components/CameraCapture'
import { MusicSheet } from '../components/studio/MusicSheet'
import { DrawPad, MentionSheet, OverlayLayer, StickerSheet, StudioSheet, TextEditor } from '../components/studio/Overlays'
import { ShareSheet, type Audience } from '../components/studio/Audience'
import { TrackArt } from './create/pickers'
import { Avatar, errMsg, toast } from '../ui'

type Tool = 'text' | 'stickers' | 'music' | 'effects' | 'mention' | 'draw' | 'more' | 'share' | null
type Picked = { file: File; url: string; kind: 'photo' | 'video' }

/**
 * Share a memory, studio style: a full-screen canvas with the tools down the side (text, stickers, music, effects,
 * mentions, drawing, save) and a caption, then share to your memory (everyone or friends) or to Close Friends in one tap.
 * Memories last 24 hours unless kept as a highlight.
 */
export default function MemoryCreate() {
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const loc = useLocation() as { state?: { file?: File; song?: StudioSong } }
  const [media, setMedia] = useState<Picked | null>(null)
  const [textMode, setTextMode] = useState(false)
  const [cam, setCam] = useState(false)
  const [text, setText] = useState('')
  const [bg, setBg] = useState('violet')
  const [caption, setCaption] = useState('')
  const [overlays, setOverlays] = useState<Overlay[]>([])
  const [filter, setFilter] = useState<FilterKey>('none')
  const [song, setSong] = useState<StudioSong | null>(loc.state?.song ?? null)
  const [tool, setTool] = useState<Tool>(null)
  const [editing, setEditing] = useState<TextOverlay | null>(null)
  const [labels, setLabels] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [story, setStory] = useState<'public' | 'friends'>('friends')
  const [audience, setAudience] = useState<Audience>('friends')
  const [highlight, setHighlight] = useState(false)
  const [muted, setMuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const gallery = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null)
  const img = useRef<HTMLImageElement>(null)
  useEffect(() => { document.title = 'Share a memory · VYBE' }, [])
  useEffect(() => () => { if (media) URL.revokeObjectURL(media.url) }, [media])
  useEffect(() => { if (loc.state?.file) pick(loc.state.file) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The chosen song plays while you edit (paused under a sheet that plays its own audio).
  const [songLocal, setSongLocal] = useState<string | null>(null)
  const [songSrc, setSongSrc] = useState<string | null>(null)
  useEffect(() => { const u = song?.file ? URL.createObjectURL(song.file) : null; setSongLocal(u); return () => { if (u) URL.revokeObjectURL(u) } }, [song?.file])
  useEffect(() => { let live = true; if (!song) { setSongSrc(null); return } void songUrl(song, songLocal).then(u => live && setSongSrc(u)); return () => { live = false } }, [song, songLocal])
  const player = useSongPlayer(songSrc, { playing: Boolean(song) && tool !== 'music' && !cam, start_ms: song?.start_ms ?? 0, muted })

  const pick = (f?: File) => {
    if (!f) return
    const c = validateMedia(f)
    if (!c.ok) return toast(c.error)
    setTextMode(false); setCam(false); setMedia({ file: f, url: URL.createObjectURL(f), kind: c.type === 'video' ? 'video' : 'photo' })
  }
  const editing_ = Boolean(media || textMode)
  const ready = media ? true : text.trim().length > 0

  const share = async (to: Audience) => {
    if (!uid || busy) return
    if (!ready) { toast(textMode ? 'Type something first.' : 'Choose a photo or video first.'); return }
    setBusy(true)
    try {
      const id = await createMemory(uid, {
        ...(media ? { kind: media.kind, file: media.file, text: caption } : { kind: 'text' as const, text, bg }),
        visibility: to, overlays, filter: media ? filter : 'none', song: song ? { track_id: song.track_id, title: song.title, artist: song.artist, file: song.file, start_ms: song.start_ms } : null,
      })
      if (highlight) await supabase.from('memories').update({ highlight: true }).eq('id', id)
      playSound('share'); toast(to === 'close_friends' ? 'Shared with Close Friends' : 'Memory shared')
      nav('/app', { replace: true })
    } catch (e) { toast(errMsg(e)); setBusy(false) }
  }
  const save = async () => {
    try {
      if (media?.kind === 'video') { downloadBlob(media.file, media.file.name || 'memory.mp4'); return toast('Saved the original video') }
      const blob = await renderStill({ img: media ? img.current : null, bg: media ? undefined : MEMORY_BG[bg], text: media ? undefined : text, filter, overlays })
      if (blob) { downloadBlob(blob, `vybe-memory-${Date.now()}.jpg`); toast('Saved to your device') }
    } catch (e) { toast(errMsg(e)) }
  }
  const addPlaced = (o: Overlay) => setOverlays(x => [...x, o])

  if (cam) return <CameraCapture onCapture={f => pick(f)} onClose={() => setCam(false)} onUnavailable={() => { setCam(false); camera.current?.click() }} />

  const inputs = (
    <>
      <input ref={gallery} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={camera} type="file" hidden accept="image/*,video/*" capture="environment" onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
    </>
  )

  if (!editing_) return (
    <div className="mst mst-start" role="dialog" aria-modal="true" aria-label="Share a memory">
      {inputs}
      <header className="mst-starthead">
        <button className="mst-round" aria-label="Close" onClick={() => nav(-1)}><X size={24} /></button>
        <h1>New memory</h1>
        <span style={{ width: 48 }} />
      </header>
      <div className="mst-sources">
        <button className="mst-source hero" onClick={() => setCam(true)}><Camera size={34} aria-hidden /><b>Camera</b><span>Take a photo or record a video</span></button>
        <button className="mst-source" onClick={() => gallery.current?.click()}><ImagePlus size={28} aria-hidden /><b>Gallery</b><span>Photos and videos</span></button>
        <button className="mst-source" onClick={() => setTextMode(true)}><Type size={28} aria-hidden /><b>Text</b><span>Words on colour</span></button>
        <button className="mst-source" onClick={() => setTool('music')}><Music2 size={28} aria-hidden /><b>Music</b><span>{song ? song.title : 'Start with a song'}</span></button>
        <Link className="mst-source" to="/app/reels/new"><Clapperboard size={28} aria-hidden /><b>Reel</b><span>Record a short video</span></Link>
      </div>
      <p className="mst-fine">Memories disappear after 24 hours unless you keep them as a highlight.</p>
      {tool === 'music' && <MusicSheet value={song} onPick={setSong} onClose={() => setTool(null)} />}
    </div>
  )

  const RAIL: { key: Exclude<Tool, null | 'share'> | 'save'; label: string; icon: React.ReactNode }[] = [
    { key: 'text', label: 'Text', icon: <span className="mst-aa" aria-hidden>Aa</span> },
    { key: 'stickers', label: 'Stickers', icon: <Smile size={26} aria-hidden /> },
    { key: 'music', label: 'Music', icon: <Music2 size={26} aria-hidden /> },
    ...(media ? [{ key: 'effects' as const, label: 'Effects', icon: <Sparkles size={26} aria-hidden /> }] : []),
    { key: 'mention', label: 'Mention', icon: <AtSign size={26} aria-hidden /> },
    { key: 'draw', label: 'Draw', icon: <PenLine size={26} aria-hidden /> },
    { key: 'save', label: 'Save', icon: <Download size={26} aria-hidden /> },
    { key: 'more', label: 'More', icon: <MoreHorizontal size={26} aria-hidden /> },
  ]
  const blurBg = media?.kind === 'photo' ? { backgroundImage: `url(${media.url})` } : undefined

  return (
    <div className="mst" role="dialog" aria-modal="true" aria-label="Edit your memory">
      {inputs}
      <div className="mst-stage" style={!media ? { background: MEMORY_BG[bg] } : undefined}>
        {media && <span className="mst-blur" style={blurBg} aria-hidden />}
        {media?.kind === 'photo' && <img ref={img} className="mst-media" src={media.url} alt="Your memory" style={{ filter: filterCss(filter) }} />}
        {media?.kind === 'video' && <video className="mst-media" src={media.url} autoPlay loop playsInline muted={Boolean(song) || muted} style={{ filter: filterCss(filter) }} aria-label="Your memory video" />}
        {!media && <textarea className="mst-cardtext" aria-label="Your memory" placeholder="Start typing" value={text} maxLength={500} onChange={e => setText(e.target.value)} autoFocus />}
        <OverlayLayer items={overlays} editable={tool === null} onChange={setOverlays} onEditText={o => { setEditing(o); setTool('text') }} onDragging={setDragging} />

        {!dragging && tool !== 'draw' && (
          <>
            <button className="mst-round mst-back" aria-label="Back" onClick={() => { if (media || text) { if (confirm('Discard this memory?')) { setMedia(null); setTextMode(false); setOverlays([]); setText('') } } else { setTextMode(false) } }}><ArrowLeft size={26} /></button>
            {song && (
              <button className="mst-song" onClick={() => setTool('music')} aria-label={`Song: ${song.title} by ${song.artist}. Change`}>
                <TrackArt path={song.artwork_path} size={28} /><span className="clamp-1"><b>{song.title}</b> · {song.artist}</span>
              </button>
            )}
            {(song || media?.kind === 'video') && <button className="mst-round mst-mute" aria-label={muted ? 'Sound on' : 'Sound off'} aria-pressed={!muted} onClick={() => { setMuted(m => !m); player.unblock() }}>{muted ? <VolumeX size={22} /> : <Volume2 size={22} />}</button>}
            <nav className={`mst-rail${labels ? '' : ' compact'}`} aria-label="Tools">
              {RAIL.map(r => (
                <button key={r.key} className="mst-tool" onClick={() => (r.key === 'save' ? void save() : setTool(r.key))}>
                  {labels && <span className="mst-label">{r.label}</span>}<span className="mst-ico">{r.icon}</span>
                </button>
              ))}
              <button className="mst-tool" aria-label={labels ? 'Hide tool names' : 'Show tool names'} onClick={() => setLabels(l => !l)}><span className="mst-ico small"><ChevronUp size={22} style={{ transform: labels ? undefined : 'rotate(180deg)' }} aria-hidden /></span></button>
            </nav>
            {media && <input className="mst-caption" aria-label="Add a caption" placeholder="Add a caption…" value={caption} maxLength={500} onChange={e => setCaption(e.target.value)} />}
            {!media && (
              <div className="mst-bgs" role="group" aria-label="Background">
                {Object.keys(MEMORY_BG).map(k => <button key={k} className={`mst-bgdot${bg === k ? ' on' : ''}`} aria-pressed={bg === k} aria-label={`Background ${k}`} onClick={() => setBg(k)} style={{ background: MEMORY_BG[k] }} />)}
              </div>
            )}
          </>
        )}
        {tool === 'effects' && media && (
          <div className="mst-fx" role="group" aria-label="Effects">
            <div className="mst-fx-row">
              {FILTERS.map(f => (
                <button key={f.key} className={`mst-fx-item${filter === f.key ? ' on' : ''}`} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                  <span className="mst-fx-thumb" style={media.kind === 'photo' ? { backgroundImage: `url(${media.url})`, filter: f.css } : { filter: f.css }} aria-hidden />{f.label}
                </button>
              ))}
            </div>
            <button className="mst-fx-done" onClick={() => setTool(null)}>Done</button>
          </div>
        )}
        {tool === 'draw' && <DrawPad items={overlays} onChange={setOverlays} onDone={() => setTool(null)} />}
      </div>

      {!dragging && tool !== 'draw' && tool !== 'effects' && (
        <div className="mst-bar">
          <button className="mst-dest" disabled={busy} onClick={() => void share(story)}>
            <span className="mst-dest-av"><Avatar size="sm" path={profile?.avatar_path} name={profile?.display_name || profile?.username || 'You'} /></span>Your memory
          </button>
          <button className="mst-dest" disabled={busy} onClick={() => setTool('share')}><span className="cf-badge" aria-hidden><Star size={14} fill="currentColor" /></span>Close Friends</button>
          <button className="mst-go" aria-label="More sharing options" disabled={busy} onClick={() => setTool('share')}><ChevronRight size={28} /></button>
        </div>
      )}

      {tool === 'text' && <TextEditor initial={editing} onCancel={() => { setEditing(null); setTool(null) }} onDone={o => { setOverlays(x => (editing ? (o ? x.map(y => (y.id === o.id ? o : y)) : x.filter(y => y.id !== editing.id)) : o ? [...x, o] : x)); setEditing(null); setTool(null) }} />}
      {tool === 'stickers' && <StickerSheet onClose={() => setTool(null)} onPick={e => { addPlaced({ t: 'sticker', id: newId(), emoji: e, x: 0.5, y: 0.45, size: 1.2 }); setTool(null) }} />}
      {tool === 'mention' && <MentionSheet onClose={() => setTool(null)} onPick={p => { addPlaced({ t: 'mention', id: newId(), uid: p.id, username: p.username, x: 0.5, y: 0.55, size: 0.9 }); setTool(null) }} />}
      {tool === 'music' && <MusicSheet value={song} onPick={setSong} onClose={() => setTool(null)} />}
      {tool === 'more' && (
        <StudioSheet title="More" onClose={() => setTool(null)}>
          <div className="ss-menu">
            <button onClick={() => { setLabels(l => !l); setTool(null) }}>{labels ? 'Hide tool names' : 'Show tool names'}</button>
            {media && <button onClick={() => { gallery.current?.click(); setTool(null) }}>Replace photo or video</button>}
            {song && <button onClick={() => { setSong(null); setTool(null) }}>Remove song</button>}
            {overlays.some(o => o.t === 'draw') && <button onClick={() => { setOverlays(x => x.filter(o => o.t !== 'draw')); setTool(null) }}>Clear drawing</button>}
            {overlays.length > 0 && <button onClick={() => { setOverlays([]); setTool(null) }}>Remove all text and stickers</button>}
            {media && filter !== 'none' && <button onClick={() => { setFilter('none'); setTool(null) }}>Remove effect</button>}
            <button className="danger" onClick={() => nav(-1)}>Discard memory</button>
          </div>
        </StudioSheet>
      )}
      {tool === 'share' && (
        <ShareSheet audience={audience} story={story} onAudience={setAudience} onStory={setStory} highlight={highlight} onHighlight={setHighlight} busy={busy}
          preview={<div className="shs-thumb" style={media ? undefined : { background: MEMORY_BG[bg] }}>{media?.kind === 'photo' ? <img src={media.url} alt="" style={{ filter: filterCss(filter) }} /> : media ? <video src={media.url} muted playsInline style={{ filter: filterCss(filter) }} /> : <span>{text.slice(0, 60)}</span>}</div>}
          onShare={() => void share(audience)} onClose={() => setTool(null)} />
      )}
      {player.blocked && song && <button className="mst-tapsound" onClick={player.unblock}><Volume2 size={16} aria-hidden /> Tap for sound</button>}
    </div>
  )
}
