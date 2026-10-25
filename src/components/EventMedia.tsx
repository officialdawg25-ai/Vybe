import { useRef, useState } from 'react'
import { Film, ImagePlus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { MAX_VIDEO_BYTES, shrinkImage, uploadMedia } from '../lib/media'
import { Sheet, errMsg, toast, useSigned } from '../ui'

type Slot = 'cover' | 'video'

/**
 * The event's look: a cover picture (fills the event page header and every card for the event) and an optional short
 * looping background video behind the header, like a music app's artist page. Files go to the editor's own folder; the
 * database only accepts media the editor uploaded (or their organisation's library), so nobody can borrow someone else's.
 */
export function EventMediaSheet({ eventId, cover, video, onSaved, onClose }: { eventId: string; cover: string | null; video: string | null; onSaved: () => void; onClose: () => void }) {
  const { uid } = useAuth()
  const coverUrl = useSigned(cover)
  const videoUrl = useSigned(video)
  const [busy, setBusy] = useState<Slot | null>(null)
  const [pct, setPct] = useState(0)
  const [err, setErr] = useState('')
  const pickCover = useRef<HTMLInputElement>(null)
  const pickVideo = useRef<HTMLInputElement>(null)

  const save = async (patch: Record<string, string | null>, done: string) => {
    const { error } = await supabase.from('events').update(patch).eq('id', eventId)
    if (error) throw error
    toast(done); onSaved()
  }
  const upload = async (slot: Slot, file: File | undefined) => {
    if (!file || !uid) return
    setErr('')
    if (slot === 'cover' && !file.type.startsWith('image/')) return setErr('Choose a photo (JPG, PNG, WebP or GIF).')
    if (slot === 'video' && !file.type.startsWith('video/')) return setErr('Choose a video (MP4, WebM or MOV).')
    if (slot === 'video' && file.size > MAX_VIDEO_BYTES) return setErr('Background videos must be 50 MB or smaller. A short loop of 5 to 15 seconds works best.')
    setBusy(slot); setPct(0)
    try {
      const up = await uploadMedia(uid, slot === 'cover' ? await shrinkImage(file, 2400) : file, { first: true, onProgress: (s, t) => setPct(t ? Math.round((s / t) * 100) : 0) })
      await save(slot === 'cover' ? { cover_path: up.path } : { hero_video_path: up.path }, slot === 'cover' ? 'Cover updated' : 'Background video updated')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(null) }
  }
  const remove = async (slot: Slot) => {
    setErr(''); setBusy(slot)
    try { await save(slot === 'cover' ? { cover_path: null } : { hero_video_path: null }, slot === 'cover' ? 'Cover removed' : 'Background video removed') } catch (e) { setErr(errMsg(e)) } finally { setBusy(null) }
  }

  return (
    <Sheet title="Event look" onClose={onClose}>
      <div className="evm">
        <section className="evm-slot" aria-labelledby="evm-c">
          <div className="evm-prev" style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}>{!coverUrl && <ImagePlus size={28} aria-hidden />}</div>
          <div className="evm-copy">
            <h3 id="evm-c">Cover photo</h3>
            <p className="t-meta">Fills the top of the event page and every card for this event. Portrait or square photos look best.</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn sm primary" disabled={busy != null} onClick={() => pickCover.current?.click()}><ImagePlus size={16} aria-hidden /> {busy === 'cover' ? `Uploading ${pct}%` : cover ? 'Replace' : 'Upload photo'}</button>
              {cover && <button className="btn sm ghost" disabled={busy != null} onClick={() => void remove('cover')}><Trash2 size={16} aria-hidden /> Remove</button>}
            </div>
          </div>
          <input ref={pickCover} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={e => { void upload('cover', e.target.files?.[0]); e.target.value = '' }} />
        </section>
        <section className="evm-slot" aria-labelledby="evm-v">
          <div className="evm-prev">{videoUrl ? <video src={videoUrl} muted loop autoPlay playsInline aria-label="Current background video" /> : <Film size={28} aria-hidden />}</div>
          <div className="evm-copy">
            <h3 id="evm-v">Background video <span className="t-meta">(optional)</span></h3>
            <p className="t-meta">A silent loop that plays behind the title. The cover photo shows while it loads and for people who prefer less motion.</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn sm primary" disabled={busy != null} onClick={() => pickVideo.current?.click()}><Film size={16} aria-hidden /> {busy === 'video' ? `Uploading ${pct}%` : video ? 'Replace' : 'Upload video'}</button>
              {video && <button className="btn sm ghost" disabled={busy != null} onClick={() => void remove('video')}><Trash2 size={16} aria-hidden /> Remove</button>}
            </div>
          </div>
          <input ref={pickVideo} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={e => { void upload('video', e.target.files?.[0]); e.target.value = '' }} />
        </section>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </Sheet>
  )
}
