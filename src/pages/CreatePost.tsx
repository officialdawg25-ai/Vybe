import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Camera, ChevronDown, Globe, ImagePlus, MapPin, Music2, Plus, Smile, UserPlus, Users, Video, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, Sheet, errMsg, toast } from '../ui'
import { supabase } from '../lib/supabase'
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, uploadMedia, validateMedia } from '../lib/media'
import { isMissingSchema } from '../lib/tickets'
import { moodOf, moodText } from '../lib/social'
import { playSound } from '../lib/sounds'
import { FeelingPicker, MusicPicker, PlacePicker, TagPeople, TrackArt, type PickedPlace, type PickedSong } from './create/pickers'
import type { PublicProfile } from '../lib/types'

type View = 'main' | 'feeling' | 'tag' | 'place' | 'music'
interface Att { id: string; file: File; url: string; type: 'image' | 'video' }
const MAX_FILES = 10
const DRAFT = 'vybe:draft-post'
const TITLES: Record<View, string> = { main: 'New post', feeling: 'How are you feeling?', tag: 'Tag people', place: 'Add location', music: 'Add music' }

/**
 * Full-screen post composer: text, up to 10 photos/videos (gallery, camera or a fresh recording), feeling or activity, place, song
 * and tagged friends. Everything optional is stored in dedicated columns/tables, never inside the text.
 */
export default function CreatePost() {
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const communityId = params.get('community') ?? undefined, organizationId = params.get('org') ?? undefined, eventId = params.get('event') ?? undefined
  const [view, setView] = useState<View>('main')
  const [body, setBody] = useState(() => { try { return localStorage.getItem(DRAFT) ?? '' } catch { return '' } })
  const [atts, setAtts] = useState<Att[]>([])
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [feeling, setFeeling] = useState<string | null>(null)
  const [place, setPlace] = useState<PickedPlace | null>(null)
  const [song, setSong] = useState<PickedSong | null>(null)
  const [tags, setTags] = useState<PublicProfile[]>([])
  const [audience, setAudience] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState<null | { step: number; of: number }>(null)
  const [err, setErr] = useState('')
  const gallery = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null), recorder = useRef<HTMLInputElement>(null), area = useRef<HTMLTextAreaElement>(null)
  const name = profile?.display_name || profile?.username || ''
  useEffect(() => { document.title = 'New post · VYBE' }, [])
  useEffect(() => { try { body ? localStorage.setItem(DRAFT, body) : localStorage.removeItem(DRAFT) } catch { /* storage unavailable */ } }, [body])
  useEffect(() => () => { atts.forEach(a => URL.revokeObjectURL(a.url)) }, [])        // eslint-disable-line react-hooks/exhaustive-deps
  // Arriving from the music page with a song chosen.
  const trackParam = params.get('track')
  useEffect(() => {
    if (!trackParam || !/^[0-9a-f-]{36}$/i.test(trackParam)) return
    supabase.from('music_tracks').select('id,title,artist,external_url,preview_path,artwork_path').eq('id', trackParam).maybeSingle().then(({ data }) => {
      if (data) setSong({ track_id: data.id, title: data.title, artist: data.artist, url: data.external_url ?? undefined, preview_path: data.preview_path, artwork_path: data.artwork_path })
    })
  }, [trackParam])
  useEffect(() => { if (view === 'main') area.current?.focus({ preventScroll: true }) }, [view])
  useEffect(() => { const el = area.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 360)}px` } }, [body, view])

  const add = (list: FileList | null) => {
    if (!list?.length) return
    const next: Att[] = []
    let rejected = ''
    for (const f of Array.from(list)) {
      if (atts.length + next.length >= MAX_FILES) { rejected = `You can add up to ${MAX_FILES} photos and videos.`; break }
      const c = validateMedia(f)
      if (!c.ok) { rejected = c.error; continue }
      next.push({ id: crypto.randomUUID(), file: f, url: URL.createObjectURL(f), type: c.type })
    }
    if (rejected) toast(rejected)
    if (next.length) { setAtts(a => [...a, ...next]); setErr('') }
  }
  const removeAtt = (id: string) => setAtts(a => { const x = a.find(y => y.id === id); if (x) URL.revokeObjectURL(x.url); return a.filter(y => y.id !== id) })

  const mood = moodOf(feeling)
  const dirty = Boolean(body.trim() || atts.length || feeling || place || song || tags.length)
  const canPost = dirty && !busy
  const close = () => { if (view !== 'main') return setView('main'); if (dirty) setLeaving(true); else nav(-1) }
  const discard = () => { try { localStorage.removeItem(DRAFT) } catch { /* ignore */ } nav('/app', { replace: true }) }

  const post = async () => {
    if (!canPost || !uid) return
    setErr(''); setBusy({ step: 0, of: atts.length })
    const uploaded: { path: string; type: 'image' | 'video' }[] = []
    try {
      for (const [i, a] of atts.entries()) { setBusy({ step: i + 1, of: atts.length }); uploaded.push(await uploadMedia(uid, a.file)) }
      const extras = {
        ...(feeling ? { feeling } : {}), ...(place ? { place_name: place.name, place_lat: place.lat, place_lng: place.lng } : {}),
        ...(song ? { music_track_id: song.track_id ?? null, music_title: song.title, music_artist: song.artist, music_url: song.url ?? null } : {}),
      }
      const row = {
        author: uid, body: body.trim(), media_path: uploaded[0]?.path ?? null, media_type: uploaded[0]?.type ?? null,
        visibility: communityId ? 'community' : organizationId ? 'public' : visibility, community_id: communityId ?? null, event_id: eventId ?? null,
        ...(organizationId ? { organization_id: organizationId } : {}), ...extras,
      }
      const ins = await supabase.from('posts').insert(row).select('id').single()
      if (ins.error) throw ins.error
      const postId = ins.data.id as string
      if (uploaded.length) {
        const m = await supabase.from('post_media').insert(uploaded.map((u, sort) => ({ post_id: postId, sort, path: u.path, type: u.type })))
        if (m.error && !(isMissingSchema(m.error) && uploaded.length === 1)) { await supabase.from('posts').delete().eq('id', postId); throw m.error }
      }
      if (tags.length) {
        const t = await supabase.from('post_tags').insert(tags.map(p => ({ post_id: postId, user_id: p.id })))
        if (t.error) toast('Posted, but the tags could not be saved.')
      }
      playSound('send'); try { localStorage.removeItem(DRAFT) } catch { /* ignore */ }
      toast('Posted'); nav(communityId ? `/app/communities/${communityId}` : '/app', { replace: true })
    } catch (e) {
      if (uploaded.length) await supabase.storage.from('media').remove(uploaded.map(u => u.path))
      const m = errMsg(e)
      setErr(isMissingSchema(e as { code?: string; message?: string }) ? 'This server needs its latest update before it can save feelings, places, songs and tags.' : m.includes('rate limit') ? "You're posting too fast. Try again in a few minutes." : m)
      setBusy(null)
    }
  }

  const summary = useMemo(() => {
    const bits: string[] = []
    if (mood) bits.push(`${mood.emoji} ${moodText(mood)}`)
    if (place) bits.push(`at ${place.name}`)
    if (tags.length) bits.push(`with ${tags[0].display_name || tags[0].username}${tags.length > 1 ? ` and ${tags.length - 1} ${tags.length === 2 ? 'other' : 'others'}` : ''}`)
    return bits.join(' · ')
  }, [mood, place, tags])

  return (
    <div className="cp" role="dialog" aria-modal="true" aria-label={TITLES[view]}>
      <header className="cp-head">
        <button className="icon-btn" aria-label={view === 'main' ? 'Close' : 'Back'} onClick={close}>{view === 'main' ? <X size={26} /> : <ArrowLeft size={24} />}</button>
        <h1 className="cp-title">{TITLES[view]}</h1>
        {view === 'main'
          ? <button className="cp-post" disabled={!canPost} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
          : view === 'tag' ? <button className="cp-post" onClick={() => setView('main')}>Done{tags.length ? ` (${tags.length})` : ''}</button>
          : <span style={{ width: 64 }} />}
      </header>

      {view === 'main' && (
        <div className="cp-body">
          <div className="cp-who">
            <Avatar size="lg" path={profile?.avatar_path} name={name || '?'} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="t-name clamp-1" style={{ fontSize: '1.125rem' }}>{name}</div>
              {!communityId && !organizationId
                ? <button className="cp-aud" onClick={() => setAudience(true)} aria-haspopup="dialog">{visibility === 'public' ? <Globe size={14} aria-hidden /> : <Users size={14} aria-hidden />} {visibility === 'public' ? 'Public' : 'Friends'} <ChevronDown size={14} aria-hidden /></button>
                : <span className="cp-aud static">{communityId ? 'Community' : 'Page post · Public'}</span>}
            </div>
          </div>
          {summary && <p className="cp-summary" aria-live="polite">{summary}</p>}
          <div className="cp-chips" role="group" aria-label="Add to your post">
            <button className={`cp-chip${song ? ' on' : ''}`} onClick={() => setView('music')}><Music2 size={18} aria-hidden /> Music</button>
            <button className={`cp-chip${tags.length ? ' on' : ''}`} onClick={() => setView('tag')}><UserPlus size={18} aria-hidden /> People</button>
            <button className={`cp-chip${place ? ' on' : ''}`} onClick={() => setView('place')}><MapPin size={18} aria-hidden /> Location</button>
            <button className={`cp-chip${feeling ? ' on' : ''}`} onClick={() => setView('feeling')}><Smile size={18} aria-hidden /> Feeling/activity</button>
          </div>
          <textarea ref={area} className="cp-text" aria-label="What's on your mind?" placeholder="What's on your mind?" value={body} maxLength={5000} onChange={e => setBody(e.target.value)} rows={3} />
          {song && (
            <div className="cp-song">
              <TrackArt path={song.artwork_path} /><span className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-1" style={{ display: 'block' }}>{song.title}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{song.artist}</span></span>
              <button className="icon-btn" aria-label="Remove song" onClick={() => setSong(null)}><X size={20} /></button>
            </div>
          )}
          {atts.length > 0 && (
            <ul className={`cp-media n${Math.min(atts.length, 4)}`} aria-label="Attached photos and videos">
              {atts.map((a, i) => (
                <li key={a.id}>
                  {a.type === 'video' ? <video src={a.url} muted playsInline preload="metadata" aria-label={`Video ${i + 1}`} /> : <img src={a.url} alt={`Photo ${i + 1}`} />}
                  {a.type === 'video' && <span className="cp-vtag"><Video size={12} aria-hidden /> Video</span>}
                  <button className="cp-rm" aria-label={`Remove attachment ${i + 1}`} onClick={() => removeAtt(a.id)} disabled={Boolean(busy)}><X size={16} /></button>
                  {busy && busy.step === i + 1 && <span className="cp-up" role="status">Uploading…</span>}
                </li>
              ))}
              {atts.length < MAX_FILES && <li><button className="cp-add" onClick={() => gallery.current?.click()} aria-label="Add more photos or videos"><Plus size={28} /></button></li>}
            </ul>
          )}
          {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
          <p className="t-meta cp-limits">Photos up to {MAX_IMAGE_BYTES / 1024 / 1024} MB and videos up to {MAX_VIDEO_BYTES / 1024 / 1024} MB, {MAX_FILES} items at most.{body.length > 4500 ? ` ${5000 - body.length} characters left.` : ''}</p>
        </div>
      )}
      {view === 'feeling' && <FeelingPicker value={feeling} onPick={k => { setFeeling(k); setView('main') }} />}
      {view === 'tag' && <TagPeople selected={tags} onChange={setTags} />}
      {view === 'place' && <PlacePicker value={place} onPick={p => { setPlace(p); setView('main') }} />}
      {view === 'music' && <MusicPicker value={song} onPick={s => { setSong(s); setView('main') }} />}

      {view === 'main' && (
        <>
          <input ref={gallery} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={e => { add(e.target.files); e.target.value = '' }} />
          <input ref={camera} type="file" hidden accept="image/*" capture="environment" onChange={e => { add(e.target.files); e.target.value = '' }} />
          <input ref={recorder} type="file" hidden accept="video/*" capture="environment" onChange={e => { add(e.target.files); e.target.value = '' }} />
          <nav className="cp-bar" aria-label="Add to post">
            <button aria-label="Photos and videos from your gallery" onClick={() => gallery.current?.click()}><ImagePlus size={24} /></button>
            <button aria-label="Take a photo" onClick={() => camera.current?.click()}><Camera size={24} /></button>
            <button aria-label="Record a video" onClick={() => recorder.current?.click()}><Video size={24} /></button>
            <button aria-label="Tag people" onClick={() => setView('tag')}><UserPlus size={24} /></button>
            <button aria-label="Feeling or activity" onClick={() => setView('feeling')}><Smile size={24} /></button>
            <button aria-label="Add location" onClick={() => setView('place')}><MapPin size={24} /></button>
            <button aria-label="Add music" onClick={() => setView('music')}><Music2 size={24} /></button>
          </nav>
        </>
      )}
      {audience && (
        <Sheet title="Who can see your post?" onClose={() => setAudience(false)}>
          <div className="stack" style={{ gap: 8 }}>
            {([['public', 'Public', 'Anyone on VYBE', Globe], ['friends', 'Friends', 'Only your friends', Users]] as const).map(([k, l, d, Ico]) => (
              <button key={k} className={`cp-opt${visibility === k ? ' on' : ''}`} aria-pressed={visibility === k} onClick={() => { setVisibility(k); setAudience(false) }}>
                <Ico size={22} aria-hidden /><span className="grow"><b>{l}</b><span className="t-meta" style={{ display: 'block' }}>{d}</span></span>
              </button>))}
          </div>
        </Sheet>
      )}
      {leaving && (
        <Sheet title="Discard this post?" onClose={() => setLeaving(false)}>
          <div className="stack" style={{ gap: 8 }}>
            <button className="btn" onClick={() => { setLeaving(false); nav(-1) }}>Save the text as a draft</button>
            <button className="btn danger" onClick={discard}>Discard</button>
            <button className="btn ghost" onClick={() => setLeaving(false)}>Keep editing</button>
          </div>
        </Sheet>
      )}
    </div>
  )
}
