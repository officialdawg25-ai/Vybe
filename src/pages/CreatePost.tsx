import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Camera, ChevronDown, Globe, ImagePlus, MapPin, Music2, Plus, Smile, UserPlus, Users, Video, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, Sheet, errMsg, toast } from '../ui'
import { supabase } from '../lib/supabase'
import { discardUploads, fileSize, titleFromFile, uploadMedia, uploadSong, validateMedia } from '../lib/media'
import { isMissingSchema } from '../lib/tickets'
import { fetchPosts } from '../lib/posts'
import { moodOf, moodText } from '../lib/social'
import { playSound } from '../lib/sounds'
import { FeelingPicker, MusicPicker, PlacePicker, TagPeople, TrackArt, type PickedPlace, type PickedSong } from './create/pickers'
import type { PublicProfile } from '../lib/types'

type View = 'main' | 'feeling' | 'tag' | 'place' | 'music'
/**
 * A picked photo or video. Its upload starts the moment it is picked and runs in the background while the member writes:
 * `status` is the real state of the transfer, and only `done` attachments (confirmed by Storage) are ever attached to a post.
 */
interface Att { id: string; file: File; url: string; type: 'image' | 'video'; status: 'uploading' | 'done' | 'failed'; sent: number; path?: string; error?: string }
type Job = { promise: Promise<{ path: string; type: 'image' | 'video' }>; ctrl: AbortController }
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
  const loc = useLocation()
  const communityId = params.get('community') ?? undefined, organizationId = params.get('org') ?? undefined, eventId = params.get('event') ?? undefined
  const [view, setView] = useState<View>('main')
  const [body, setBody] = useState(() => { try { return localStorage.getItem(DRAFT) ?? '' } catch { return '' } })
  const [atts, setAtts] = useState<Att[]>([])
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [feeling, setFeeling] = useState<string | null>(null)
  const [place, setPlace] = useState<PickedPlace | null>(null)
  // Arriving from the music page with a song picked from the device (the File travels in the navigation state).
  const [song, setSong] = useState<PickedSong | null>(() => { const f = (loc.state as { songFile?: File } | null)?.songFile; return f instanceof File ? { title: titleFromFile(f.name), artist: 'My music', file: f } : null })
  const [tags, setTags] = useState<PublicProfile[]>([])
  const [audience, setAudience] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState<null | 'waiting' | 'posting'>(null)
  const jobs = useRef(new Map<string, Job>())
  const songJob = useRef<{ promise: Promise<string>; ctrl: AbortController; file: File } | null>(null)
  const [songUp, setSongUp] = useState<{ sent: number; status: 'uploading' | 'done' | 'failed' } | null>(null)
  const posted = useRef(false)
  const [err, setErr] = useState('')
  const gallery = useRef<HTMLInputElement>(null), camera = useRef<HTMLInputElement>(null), recorder = useRef<HTMLInputElement>(null), area = useRef<HTMLTextAreaElement>(null)
  const name = profile?.display_name || profile?.username || ''
  useEffect(() => { document.title = 'New post · VYBE' }, [])
  useEffect(() => { try { body ? localStorage.setItem(DRAFT, body) : localStorage.removeItem(DRAFT) } catch { /* storage unavailable */ } }, [body])
  // Leaving without posting: stop transfers still running and delete what was uploaded for nothing (only the text is kept as a draft).
  const attsRef = useRef(atts); attsRef.current = atts
  useEffect(() => () => {
    attsRef.current.forEach(a => URL.revokeObjectURL(a.url))
    if (posted.current) return
    jobs.current.forEach(j => j.ctrl.abort())
    songJob.current?.ctrl.abort()
    discardUploads('media', [...attsRef.current.map(a => a.path), songPath.current])
  }, [])                                                                           // eslint-disable-line react-hooks/exhaustive-deps
  const songPath = useRef<string | null>(null)

  const patch = (id: string, p: Partial<Att>) => setAtts(list => list.map(a => (a.id === id ? { ...a, ...p } : a)))
  const startUpload = (a: Att, first = false) => {
    if (!uid) return
    const ctrl = new AbortController()
    const promise = uploadMedia(uid, a.file, { signal: ctrl.signal, first, onProgress: sent => patch(a.id, { sent }) })
    jobs.current.set(a.id, { promise, ctrl })
    promise.then(r => patch(a.id, { status: 'done', sent: a.file.size, path: r.path, error: undefined }),
      e => { if (!ctrl.signal.aborted) patch(a.id, { status: 'failed', error: errMsg(e) }) })
  }
  const retryUpload = (a: Att) => { patch(a.id, { status: 'uploading', sent: 0, error: undefined }); startUpload(a) }

  // A song from the device uploads in the background as soon as it is chosen, like photos.
  useEffect(() => {
    const f = song?.file
    if (songJob.current && songJob.current.file !== f) { songJob.current.ctrl.abort(); discardUploads('media', [songPath.current]); songJob.current = null; songPath.current = null; setSongUp(null) }
    if (!f || !uid || songJob.current) return
    const ctrl = new AbortController()
    setSongUp({ sent: 0, status: 'uploading' })
    const promise = uploadSong(uid, f, { signal: ctrl.signal, onProgress: sent => setSongUp({ sent, status: 'uploading' }) })
    songJob.current = { promise, ctrl, file: f }
    promise.then(p => { songPath.current = p; setSongUp({ sent: f.size, status: 'done' }) }, () => { if (!ctrl.signal.aborted) setSongUp(s => ({ sent: s?.sent ?? 0, status: 'failed' })) })
  }, [song?.file, uid])
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
      next.push({ id: crypto.randomUUID(), file: f, url: URL.createObjectURL(f), type: c.type, status: 'uploading', sent: 0 })
    }
    if (rejected) toast(rejected)
    if (next.length) { setAtts(a => [...a, ...next]); setErr(''); next.forEach((a, i) => startUpload(a, atts.length === 0 && i === 0)) }
  }
  const removeAtt = (id: string) => {
    const x = atts.find(y => y.id === id)
    jobs.current.get(id)?.ctrl.abort(); jobs.current.delete(id)
    if (x) { URL.revokeObjectURL(x.url); discardUploads('media', [x.path]) }
    setAtts(a => a.filter(y => y.id !== id))
  }

  const mood = moodOf(feeling)
  const dirty = Boolean(body.trim() || atts.length || feeling || place || song || tags.length)
  // A post needs something to show; tagged people alone are not a post (the database refuses empty posts too).
  const hasContent = Boolean(body.trim() || atts.length || feeling || place || song)
  const canPost = hasContent && !busy
  // Opened directly (a link, a reload) there is no in-app page to go back to, so go Home rather than leave VYBE.
  const back = () => { if ((window.history.state as { idx?: number } | null)?.idx) nav(-1); else nav('/app', { replace: true }) }
  const close = () => { if (view !== 'main') return setView('main'); if (dirty) setLeaving(true); else back() }
  const discard = () => { try { localStorage.removeItem(DRAFT) } catch { /* ignore */ } nav('/app', { replace: true }) }

  // A ref, not state: a double tap lands before React re-renders the disabled button, and must not post twice.
  const submitting = useRef(false)
  const post = async () => {
    if (!canPost || !uid || submitting.current) return
    submitting.current = true
    setErr('')
    try {
      // Wait only for transfers still running; most finish while the member is writing.
      setBusy('waiting')
      const results = await Promise.allSettled(atts.map(a => jobs.current.get(a.id)?.promise ?? Promise.reject(new Error('not started'))))
      const failed = results.filter(r => r.status === 'rejected').length
      let musicPath: string | null = null
      if (song?.file) {
        try { musicPath = await songJob.current!.promise } catch { throw new Error('The song could not be uploaded. Remove it or pick it again.') }
      }
      if (failed) throw new Error(failed === 1 ? 'One photo or video did not upload. Tap Retry on it, or remove it.' : `${failed} photos or videos did not upload. Tap Retry on them, or remove them.`)
      const uploaded = results.map((r, i) => ({ path: (r as PromiseFulfilledResult<{ path: string }>).value.path, type: atts[i].type }))
      setBusy('posting')
      const extras = {
        ...(feeling ? { feeling } : {}), ...(place ? { place_name: place.name, place_lat: place.lat, place_lng: place.lng } : {}),
        ...(song ? { music_track_id: song.track_id ?? null, music_title: song.title, music_artist: song.artist, music_url: song.url ?? null, ...(musicPath ? { music_path: musicPath } : {}) } : {}),
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
      posted.current = true
      if (tags.length) {
        const t = await supabase.from('post_tags').insert(tags.map(p => ({ post_id: postId, user_id: p.id })))
        if (t.error) toast('Posted, but the tags could not be saved.')
      }
      playSound('send'); try { localStorage.removeItem(DRAFT) } catch { /* ignore */ }
      // The authoritative record (with author, counts and gallery), so Home can show it at once without reloading the feed.
      // If this read fails the post is still saved; Home's own refresh brings it in.
      const saved = await fetchPosts({ uid, ids: [postId] }).then(r => r[0] ?? null, () => null)
      toast('Post shared')
      nav(communityId ? `/app/communities/${communityId}` : '/app', { replace: true, state: saved && !communityId ? { posted: saved } : null })
    } catch (e) {
      // Uploaded files stay attached to the draft, so trying again does not upload them a second time.
      const m = errMsg(e)
      setErr(isMissingSchema(e as { code?: string; message?: string }) ? 'This server needs its latest update before it can save feelings, places, songs and tags.' : m.includes('rate limit') ? "You're posting too fast. Try again in a few minutes." : m)
      setBusy(null)
      submitting.current = false
    }
  }
  const pending = atts.filter(a => a.status === 'uploading')
  const totalBytes = atts.reduce((n, a) => n + a.file.size, 0) + (song?.file && songUp ? song.file.size : 0)
  const sentBytes = atts.reduce((n, a) => n + (a.status === 'done' ? a.file.size : a.sent), 0) + (song?.file && songUp ? songUp.sent : 0)
  const overall = totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 100

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
          ? <button className="cp-post" disabled={!canPost} onClick={post}>{busy === 'waiting' && (pending.length || songUp?.status === 'uploading') ? `${overall}%` : busy ? 'Posting…' : 'Post'}</button>
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
              {song.file && songUp?.status === 'uploading' && <span className="t-meta" role="status">{Math.round((songUp.sent / song.file.size) * 100)}%</span>}
              {song.file && songUp?.status === 'failed' && <button className="btn sm" onClick={() => { const f = song.file!; setSong(null); setTimeout(() => setSong({ ...song, file: f }), 0) }}>Retry</button>}
            </div>
          )}
          {atts.length > 0 && (
            <ul className={`cp-media n${Math.min(atts.length, 4)}`} aria-label="Attached photos and videos">
              {atts.map((a, i) => (
                <li key={a.id}>
                  {a.type === 'video' ? <video src={a.url} muted playsInline preload="metadata" aria-label={`Video ${i + 1}`} /> : <img src={a.url} alt={`Photo ${i + 1}`} />}
                  {a.type === 'video' && <span className="cp-vtag"><Video size={12} aria-hidden /> Video</span>}
                  <button className="cp-rm" aria-label={`Remove attachment ${i + 1}`} onClick={() => removeAtt(a.id)} disabled={busy === 'posting'}><X size={16} /></button>
                  {a.status === 'uploading' && <span className="cp-prog" role="progressbar" aria-label={`Uploading attachment ${i + 1}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((a.sent / a.file.size) * 100)}><i style={{ width: `${Math.max(4, (a.sent / a.file.size) * 100)}%` }} /></span>}
                  {a.status === 'failed' && <span className="cp-up failed" role="alert"><span>Not uploaded</span><button className="btn sm" onClick={() => retryUpload(a)} aria-label={`Retry attachment ${i + 1}`}>Retry</button></span>}
                </li>
              ))}
              {atts.length < MAX_FILES && <li><button className="cp-add" onClick={() => gallery.current?.click()} aria-label="Add more photos or videos"><Plus size={28} /></button></li>}
            </ul>
          )}
          {(pending.length > 0 || songUp?.status === 'uploading') && <p className="t-meta cp-limits" role="status" aria-live="polite">Uploading {fileSize(sentBytes)} of {fileSize(totalBytes)} in the background. You can keep writing; Post waits for it.</p>}
          {err && <p className="error" role="alert" style={{ marginTop: 12 }}>{err}</p>}
          {body.length > 4500 && <p className="t-meta cp-limits">{5000 - body.length} characters left.</p>}
          {hasContent || !tags.length ? null : <p className="t-meta cp-limits">Add some words, a photo, a song, a feeling or a place to post with the people you tagged.</p>}
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
