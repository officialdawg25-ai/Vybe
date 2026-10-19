import { useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, errMsg, toast } from '../ui'
import { useSubmit } from '../lib/hooks'
import { uploadMedia, validateMedia } from '../lib/media'
import { POST_SELECT } from '../lib/posts'
import type { Post } from '../lib/types'

export function Composer({ communityId, eventId, onPosted }: { communityId?: string; eventId?: string; onPosted: (p: Post) => void }) {
  const { uid, profile } = useAuth()
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const input = useRef<HTMLInputElement>(null)

  const pick = (f: File | undefined) => {
    if (!f) return
    const check = validateMedia(f)
    if (!check.ok) { setErr(check.error); return }
    setErr(''); setFile(f)
    setPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f) })
  }
  const clear = () => { setFile(null); setPreview(null); if (input.current) input.current.value = '' }

  const post = () => submit(async () => {
    setErr('')
    let uploaded: { path: string; type: 'image' | 'video' } | null = null
    try {
      if (file) uploaded = await uploadMedia(uid!, file)
      const { data, error } = await supabase.from('posts').insert({
        author: uid, body: body.trim(), media_path: uploaded?.path ?? null, media_type: uploaded?.type ?? null,
        visibility: communityId ? 'community' : visibility, community_id: communityId ?? null, event_id: eventId ?? null,
      }).select(POST_SELECT).eq('mine_reaction.user_id', uid!).single()
      if (error) throw error
      onPosted(data as unknown as Post)
      setBody(''); clear()
    } catch (e) {
      if (uploaded) await supabase.storage.from('media').remove([uploaded.path]) // don't orphan the upload
      const m = errMsg(e)
      setErr(m.includes('rate limit') ? "You're posting too fast. Try again in a few minutes." : m)
      toast('Could not post')
    }
  })

  return (
    <section className="post" aria-label="Create a post">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Avatar path={profile?.avatar_path} name={profile?.display_name || profile?.username || '?'} />
        <div className="grow stack" style={{ gap: 8 }}>
          <textarea className="textarea" aria-label="What's on your mind?" placeholder="What's on your mind?" value={body} onChange={e => setBody(e.target.value)} maxLength={5000} style={{ minHeight: 72 }} />
          {preview && (
            <div className="post-media" style={{ position: 'relative' }}>
              {file?.type.startsWith('video') ? <video src={preview} controls /> : <img src={preview} alt="Selected upload preview" />}
              <button className="icon-btn" aria-label="Remove attachment" onClick={clear} style={{ position: 'absolute', top: 6, right: 6, background: 'var(--surface)' }}><X size={18} /></button>
            </div>
          )}
          {err && <p className="error" role="alert">{err}</p>}
          <div className="row">
            <input ref={input} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={e => pick(e.target.files?.[0])} />
            <button className="icon-btn" aria-label="Add photo or video" onClick={() => input.current?.click()}><ImagePlus size={22} /></button>
            {!communityId && (
              <select className="select" style={{ width: 'auto', minHeight: 36 }} aria-label="Who can see this" value={visibility} onChange={e => setVisibility(e.target.value as 'public' | 'friends')}>
                <option value="public">Public</option><option value="friends">Friends</option>
              </select>
            )}
            <div className="grow" />
            <button className="btn primary sm" disabled={busy || (!body.trim() && !file)} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
          </div>
        </div>
      </div>
    </section>
  )
}
