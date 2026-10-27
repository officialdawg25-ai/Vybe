import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Camera, ChevronDown, Globe, ImagePlus, MapPin, Music2, Plus, Smile, UserPlus, Users, Video, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, Sheet, errMsg, toast } from '../ui'
import { supabase } from '../lib/supabase'
import { discardUploads, fileSize, titleFromFile, uploadMedia, uploadSong, validateMedia } from '../lib/media'
import { isMissingSchema } from '../lib/tickets'
import { makeThumb, registerAsset, uploadStill, uploadThumb, type Thumb } from '../lib/library'
import { resumeStore } from '../lib/upload'
import { fetchPosts } from '../lib/posts'
import { moodOf, moodText } from '../lib/social'
import { playSound } from '../lib/sounds'
import { FeelingPicker, PlacePicker, TagPeople, TrackArt, type PickedPlace, type PickedSong } from './create/pickers'
import { MusicSheet } from '../components/studio/MusicSheet'
import { fmtMs } from '../lib/studio'
import { publish } from '../lib/publisher'
import { publishProblem } from '../lib/postRules'
import type { PublicProfile } from '../lib/types'

type View = 'main' | 'feeling' | 'tag' | 'place' | 'music'
/**
 * A picked photo or video. Its upload starts the moment it is picked and runs in the background while the member writes:
 * `status` is the real state of the transfer, and only `done` attachments (confirmed by Storage) are ever attached to a post.
 */
interface Att { id: string; file: File; url: string; type: 'image' | 'video'; status: 'uploading' | 'done' | 'failed'; sent: number; path?: string; error?: string }
type Still = { thumb: Thumb | null; path: string | null; display: string | null }
/** The upload, and what the device makes from it alongside: a still (a video's poster, the library thumbnail) and, for a big photo, the smaller copy feeds show. */
type Job = { promise: Promise<{ path: string; type: 'image' | 'video' }>; ctrl: AbortController; still: Promise<Still> }
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
  const jobs = useRef(new Map<string, Job>())
  const songJob = useRef<{ promise: Promise<string>; ctrl: AbortController; file: File } | null>(null)
  const [songUp, setSongUp] = useState<{ sent: number; status: 'uploading' | 'done' | 'failed' } | null>(null)
  const posted = useRef(false)
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
    discardUploads('media', [...attsRef.current.map(a => a.path), songPath.current, ...[...stills.current.values()].flat()])
  }, [])                                                                           // eslint-disable-line react-hooks/exhaustive-deps
  const songPath = useRef<string | null>(null)
  const stills = useRef(new Map<string, string[]>())                              // attachment id → uploaded still and display copy
  // Big uploads a reload interrupted: picking the same file again continues them (lib/upload.ts resumeStore).
  const [unfinished, setUnfinished] = useState(() => (uid ? resumeStore.pending('media', uid) : []))

  const patch = (id: string, p: Partial<Att>) => setAtts(list => list.map(a => (a.id === id ? { ...a, ...p } : a)))
  // Bytes sent per attachment, readable after this screen has closed (the background publish reports progress from it).
  const sentBy = useRef(new Map<string, number>())
  const startUpload = (a: Att, first = false) => {
    if (!uid) return
    const ctrl = new AbortController()
    const promise = uploadMedia(uid, a.file, { signal: ctrl.signal, first, onProgress: sent => { sentBy.current.set(a.id, sent); patch(a.id, { sent }) } })
    // Never blocks or fails the post: without a still, a video simply has no poster.
    // Nor does the display copy: without it, feeds show the original.
    const still: Promise<Still> = makeThumb(a.file, { display: a.type === 'image' })
      .then(async thumb => {
        const [path, display] = await Promise.all([thumb ? uploadThumb(uid, thumb, ctrl.signal).catch(() => null) : null, thumb?.display ? uploadStill(uid, thumb.display, ctrl.signal).catch(() => null) : null])
        return { thumb, path, display }
      })
      .catch(() => ({ thumb: null, path: null, display: null }))
    still.then(x => { const made = [x.path, x.display].filter((p): p is string => !!p); if (made.length) { if (ctrl.signal.aborted) discardUploads('media', made); else stills.current.set(a.id, made) } })
    jobs.current.set(a.id, { promise, ctrl, still })
    setUnfinished(u => u.filter(r => r.name !== a.file.name || r.size !== a.file.size))
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
      if (data) setSong({ track_id: data.id, title: data.title, artist: data.artist, url: data.external_url ?? undefined, preview_path: data.preview_path, artwork_path: data.artwork_path, start_ms: 0 })
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
    if (next.length) { setAtts(a => [...a, ...next]); next.forEach((a, i) => startUpload(a, atts.length === 0 && i === 0)) }
  }
  const removeAtt = (id: string) => {
    const x = atts.find(y => y.id === id)
    jobs.current.get(id)?.ctrl.abort(); jobs.current.delete(id)
    if (x) { URL.revokeObjectURL(x.url); discardUploads('media', [x.path, ...(stills.current.get(id) ?? [])]); stills.current.delete(id) }
    setAtts(a => a.filter(y => y.id !== id))
  }

  const mood = moodOf(feeling)
  const dirty = Boolean(body.trim() || atts.length || feeling || place || song || tags.length)
  // A post needs meaningful words or a photo/video; a song, feeling, place or tags alone are not a post (lib/postRules,
  // enforced by the database too: migration 34).
  const problem = publishProblem({ text: body, media: atts.length, song: Boolean(song), feeling: Boolean(feeling), place: Boolean(place), tags: tags.length })
  const hasContent = problem === null
  const canPost = hasContent
  // One key per draft: a publish that is retried (or sent twice) finds the post it already created instead of making another.
  const draftKey = useRef<string>(crypto.randomUUID())
  // Opened directly (a link, a reload) there is no in-app page to go back to, so go Home rather than leave VYBE.
  const back = () => { if ((window.history.state as { idx?: number } | null)?.idx) nav(-1); else nav('/app', { replace: true }) }
  const close = () => { if (view !== 'main') return setView('main'); if (dirty) setLeaving(true); else back() }
  const discard = () => { try { localStorage.removeItem(DRAFT) } catch { /* ignore */ } nav('/app', { replace: true }) }

  // A ref, not state: a double tap lands before React re-renders the disabled button, and must not post twice.
  const submitting = useRef(false)
  /**
   * Post, Facebook style: the member goes straight back to the feed and the post finishes in the background (lib/publisher):
   * transfers still running carry on, a failed one is started again once, then the post is saved and appears at the top
   * of Home. If it still fails, the strip under the header offers Retry (nothing is uploaded twice) or Discard.
   */
  const post = () => {
    if (!canPost || !uid || submitting.current) return
    submitting.current = true
    posted.current = true                                   // leaving now must not stop the transfers or delete them
    const me = uid, list = [...atts], picked = song, text = body.trim(), tagged = [...tags]
    const extrasBase = {
      ...(feeling ? { feeling } : {}), ...(place ? { place_name: place.name, place_lat: place.lat, place_lng: place.lng } : {}),
      ...(picked ? { music_track_id: picked.track_id ?? null, music_title: picked.title, music_artist: picked.artist, music_url: picked.url ?? null } : {}),
    }
    const where = { community_id: communityId ?? null, event_id: eventId ?? null, visibility: communityId ? 'community' : organizationId ? 'public' : visibility, ...(organizationId ? { organization_id: organizationId } : {}) }
    const jobsNow = jobs.current, sent = sentBy.current, songRef = songJob
    const firstImage = list.find(x => x.type === 'image')
    const thumb = firstImage ? URL.createObjectURL(firstImage.file) : null
    let savedId: string | null = null
    const uploadedPaths: (string | null | undefined)[] = []

    publish('post', text.slice(0, 60) || 'your post', thumb, async report => {
      if (savedId) return fetchPosts({ uid: me, ids: [savedId] }).then(r => r[0] ?? null, () => null)
      const total = list.reduce((n, x) => n + x.file.size, 0) + (picked?.file?.size ?? 0)
      const tick = window.setInterval(() => {
        if (!total) return
        const done = list.reduce((n, x) => n + Math.min(x.file.size, sent.get(x.id) ?? 0), 0)
        report(Math.min(0.95, done / total))
      }, 300)
      try {
        // Each transfer: the one already running, or, if it failed, one fresh attempt.
        const results = await Promise.all(list.map(async x => {
          const j = jobsNow.get(x.id)
          try { return await j!.promise } catch {
            const ctrl = new AbortController()
            const again = uploadMedia(me, x.file, { signal: ctrl.signal, onProgress: v => sent.set(x.id, v) })
            if (j) j.promise = again
            return again
          }
        }))
        results.forEach(r => uploadedPaths.push(r.path))
        let musicPath: string | null = null
        if (picked?.file) {
          try { musicPath = await songRef.current!.promise } catch {
            const p = uploadSong(me, picked.file); if (songRef.current) songRef.current.promise = p
            try { musicPath = await p } catch { throw new Error('The song could not be uploaded.') }
          }
          uploadedPaths.push(musicPath)
        }
        const still = await Promise.all(list.map(x => jobsNow.get(x.id)?.still ?? Promise.resolve({ thumb: null, path: null, display: null } as Still)))
        const uploaded = results.map((r, i) => ({ path: r.path, type: list[i].type, poster: list[i].type === 'video' ? still[i].path : null, display: list[i].type === 'image' ? still[i].display : null }))
        report(0.97)
        const row = {
          author: me, body: text, media_path: uploaded[0]?.path ?? null, media_type: uploaded[0]?.type ?? null, ...where, ...extrasBase,
          ...(musicPath ? { music_path: musicPath } : {}),
        }
        const start = picked?.start_ms ? { music_start_ms: Math.round(picked.start_ms) } : {}
        const key = { client_key: draftKey.current }
        let ins = await supabase.from('posts').insert({ ...row, ...start, ...key }).select('id').single()
        // Already published by an earlier attempt of this same draft: carry on with that post.
        let reused = false
        if (ins.error?.code === '23505' && /client_key/.test(ins.error.message)) { reused = true; ins = await supabase.from('posts').select('id').eq('author', me).eq('client_key', key.client_key).single() }
        // A server without the draft key (update 34) or song-start column (update 32) yet: save without them.
        if (ins.error && isMissingSchema(ins.error)) ins = await supabase.from('posts').insert({ ...row, ...start }).select('id').single()
        if (ins.error && isMissingSchema(ins.error) && 'music_start_ms' in start) ins = await supabase.from('posts').insert(row).select('id').single()
        if (ins.error && /posts_has_meaningful_content/.test(ins.error.message)) throw new Error('Add a few words, a photo or a video. A song on its own can’t be posted.')
        if (ins.error) throw new Error(isMissingSchema(ins.error) ? 'This server needs its latest update before it can save feelings, places, songs and tags.' : errMsg(ins.error).includes('rate limit') ? "You're posting too fast. Try again in a few minutes." : errMsg(ins.error))
        const postId = ins.data.id as string
        // A reused post (earlier attempt of this draft) may already have its gallery: never add it twice.
        const hasGallery = reused && ((await supabase.from('post_media').select('post_id', { count: 'exact', head: true }).eq('post_id', postId)).count ?? 0) > 0
        if (uploaded.length && !hasGallery) {
          const rows = (display: boolean) => uploaded.map((u, sort) => ({ post_id: postId, sort, path: u.path, type: u.type, ...(u.poster ? { poster_path: u.poster } : {}), ...(display && u.display ? { display_path: u.display } : {}) }))
          let m = await supabase.from('post_media').insert(rows(true))
          // A server without display copies (migration 25) or posters yet: save the gallery without them rather than fail the post.
          if (m.error && isMissingSchema(m.error) && uploaded.some(u => u.display)) {
            m = await supabase.from('post_media').insert(rows(false))
            if (!m.error) discardUploads('media', uploaded.map(u => u.display))
          }
          if (m.error && isMissingSchema(m.error) && uploaded.some(u => u.poster)) m = await supabase.from('post_media').insert(uploaded.map((u, sort) => ({ post_id: postId, sort, path: u.path, type: u.type })))
          if (m.error && !(isMissingSchema(m.error) && uploaded.length === 1)) { if (!reused) await supabase.from('posts').delete().eq('id', postId); throw m.error }
        }
        savedId = postId
        // Published photos and videos also go into the member's library, where the server checks each one. Best effort.
        list.forEach((x, i) => { void registerAsset({ path: uploaded[i].path, kind: x.type, mime: x.file.type, bytes: x.file.size, thumb: still[i].thumb, thumb_path: still[i].path, title: x.file.name.replace(/\.[^.]+$/, '') }).catch(() => {}) })
        if (tagged.length) { const t = await supabase.from('post_tags').insert(tagged.map(p => ({ post_id: postId, user_id: p.id }))); if (t.error) toast('Posted, but the tags could not be saved.') }
        playSound('send')
        // The authoritative record (with author, counts and gallery), so the feed can show it at once without reloading.
        return fetchPosts({ uid: me, ids: [postId] }).then(r => r[0] ?? null, () => null)
      } finally { window.clearInterval(tick) }
    }, {
      // Given up: remove what was uploaded for it, and its stills.
      onDiscard: () => { jobsNow.forEach(j => j.ctrl.abort()); discardUploads('media', [...uploadedPaths, ...[...stills.current.values()].flat()]) },
    })
    try { localStorage.removeItem(DRAFT) } catch { /* ignore */ }
    nav(communityId ? `/app/communities/${communityId}` : '/app', { replace: true })
  }
  const pending = atts.filter(a => a.status === 'uploading')
  const totalBytes = atts.reduce((n, a) => n + a.file.size, 0) + (song?.file && songUp ? song.file.size : 0)
  const sentBytes = atts.reduce((n, a) => n + (a.status === 'done' ? a.file.size : a.sent), 0) + (song?.file && songUp ? songUp.sent : 0)

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
          ? <button className="cp-post" disabled={!canPost} onClick={post}>Post</button>
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
              <TrackArt path={song.artwork_path} /><span className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-1" style={{ display: 'block' }}>{song.title}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{song.artist}{song.start_ms ? ` · from ${fmtMs(song.start_ms)}` : ''}</span></span>
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
                  <button className="cp-rm" aria-label={`Remove attachment ${i + 1}`} onClick={() => removeAtt(a.id)}><X size={16} /></button>
                  {a.status === 'uploading' && <span className="cp-prog" role="progressbar" aria-label={`Uploading attachment ${i + 1}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((a.sent / a.file.size) * 100)}><i style={{ width: `${Math.max(4, (a.sent / a.file.size) * 100)}%` }} /></span>}
                  {a.status === 'failed' && <span className="cp-up failed" role="alert"><span>Not uploaded</span><button className="btn sm" onClick={() => retryUpload(a)} aria-label={`Retry attachment ${i + 1}`}>Retry</button></span>}
                </li>
              ))}
              {atts.length < MAX_FILES && <li><button className="cp-add" onClick={() => gallery.current?.click()} aria-label="Add more photos or videos"><Plus size={28} /></button></li>}
            </ul>
          )}
          {(pending.length > 0 || songUp?.status === 'uploading') && <p className="t-meta cp-limits" role="status" aria-live="polite">Uploading {fileSize(sentBytes)} of {fileSize(totalBytes)} in the background. You can keep writing, or post now: it finishes in the background.</p>}
          {unfinished.length > 0 && (
            <div className="notice cp-resume" role="status">
              <p>{unfinished.length === 1 ? <>Your upload of <b>{unfinished[0].name || 'a video'}</b> stopped before it finished.</> : <>{unfinished.length} uploads stopped before they finished.</>} Add the same file again and it continues from where it stopped.</p>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm primary" onClick={() => gallery.current?.click()}>Pick the file</button>
                <button className="btn sm ghost" onClick={() => { unfinished.forEach(r => resumeStore.remove(r.key)); setUnfinished([]) }}>Start fresh</button>
              </div>
            </div>
          )}
          {body.length > 4500 && <p className="t-meta cp-limits">{5000 - body.length} characters left.</p>}
          {problem && dirty && <p className="cp-limits cp-problem" role="status">{problem}</p>}
        </div>
      )}
      {view === 'feeling' && <FeelingPicker value={feeling} onPick={k => { setFeeling(k); setView('main') }} />}
      {view === 'tag' && <TagPeople selected={tags} onChange={setTags} />}
      {view === 'place' && <PlacePicker value={place} onPick={p => { setPlace(p); setView('main') }} />}
      {view === 'music' && <MusicSheet value={song ? { ...song, start_ms: song.start_ms ?? 0 } : null} clipMs={30000}
        onPick={s => setSong(s ? { track_id: s.track_id, title: s.title, artist: s.artist, preview_path: s.preview_path, artwork_path: s.artwork_path, file: s.file, duration_ms: s.duration_ms, start_ms: s.start_ms } : null)}
        onClose={() => setView('main')} />}

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
