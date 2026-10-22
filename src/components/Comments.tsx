import { useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import { VerifiedBadge } from './VerifiedBadge'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Avatar, Spinner, errMsg, toast } from '../ui'
import { timeAgo } from '../lib/format'
import { ReportSheet } from './Report'
import { VoiceNote, VoiceRecorder } from './VoiceNote'
import { VideoNoteButton, VideoNotePlayer } from './VideoNote'
import { uploadMedia } from '../lib/media'
import { playSound } from '../lib/sounds'
import { isMissingSchema } from '../lib/tickets'
import type { PublicProfile } from '../lib/types'
import { useLiveProfiles } from '../lib/liveProfiles'

interface C { id: string; author: string; parent_id: string | null; body: string; audio_path: string | null; audio_ms: number | null; video_path?: string | null; video_ms?: number | null; created_at: string; edited_at: string | null; profiles: PublicProfile }

export function Comments({ postId, postAuthor }: { postId: string; postAuthor: string }) {
  const { uid, profile } = useAuth()
  const live = useLiveProfiles()
  const box = useRef<HTMLTextAreaElement>(null)
  const { data, loading, reload } = useAsync(async () => {
    const run = (cols: string) => supabase.from('comments').select(`*, profiles:author(${cols})`).eq('post_id', postId).order('created_at').limit(200)
    let { data, error } = await run('id,username,display_name,avatar_path,verified_until')
    if (error && isMissingSchema(error)) ({ data, error } = await run('id,username,display_name,avatar_path'))
    if (error) throw error
    return (data ?? []) as unknown as C[]
  }, [postId])
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<C | null>(null)
  const [reporting, setReporting] = useState<string | null>(null)
  const [busy, submit] = useSubmit()

  const send = () => submit(async () => {
    const { error } = await supabase.from('comments').insert({ post_id: postId, author: uid, body: body.trim(), parent_id: replyTo?.id ?? null })
    if (error) return toast(error.message.includes('rate limit') ? 'Slow down a little.' : errMsg(error))
    playSound('comment'); setBody(''); setReplyTo(null); reload()
  })
  const sendVoice = async (a: { path: string; ms: number }) => {
    const { error } = await supabase.from('comments').insert({ post_id: postId, author: uid, body: '', audio_path: a.path, audio_ms: a.ms, parent_id: replyTo?.id ?? null })
    if (error) throw new Error(error.message.includes('rate limit') ? 'Slow down a little.' : error.message)
    playSound('comment'); setReplyTo(null); reload()
  }
  // Video notes go to the author's own folder like any upload, then the comment points at them.
  const sendVideo = async (clip: { blob: Blob; mime: string; ms: number }) => {
    const file = new File([clip.blob], `note.${clip.mime === 'video/mp4' ? 'mp4' : 'webm'}`, { type: clip.mime })
    const up = await uploadMedia(uid!, file)
    const { error } = await supabase.from('comments').insert({ post_id: postId, author: uid, body: '', video_path: up.path, video_ms: Math.max(500, Math.round(clip.ms)), parent_id: replyTo?.id ?? null })
    if (error) { await supabase.storage.from('media').remove([up.path]); throw new Error(isMissingSchema(error) ? 'Video notes need the latest database update.' : error.message.includes('rate limit') ? 'Slow down a little.' : error.message) }
    playSound('comment'); setReplyTo(null); reload()
  }
  const remove = async (c: C) => {
    if (!confirm('Delete this comment?')) return
    const { error } = await supabase.from('comments').delete().eq('id', c.id)
    if (error) return toast(errMsg(error))
    const files = [c.audio_path, c.video_path].filter((x): x is string => Boolean(x))
    if (files.length && c.author === uid) await supabase.storage.from('media').remove(files)
    reload()
  }

  const roots = (data ?? []).filter(c => !c.parent_id)
  const kids = (id: string) => (data ?? []).filter(c => c.parent_id === id)
  const me = profile?.display_name || profile?.username || 'you'
  const Item = ({ c: raw, depth }: { c: C; depth: number }) => { const c = { ...raw, profiles: live(raw.profiles) }; return (
    <li className={`cmt${depth ? ' reply' : ''}`}>
      <Link to={`/app/u/${c.profiles.username}`} aria-label={`${c.profiles.display_name || c.profiles.username} profile`}><Avatar size="sm" path={c.profiles.avatar_path} uid={c.author} name={c.profiles.display_name || c.profiles.username} /></Link>
      <div className="cmt-main">
        <div className="cmt-bubble">
          <Link to={`/app/u/${c.profiles.username}`} className="cmt-name">{c.profiles.display_name || c.profiles.username}<VerifiedBadge profile={c.profiles} size={14} /></Link>
          {c.body && <p className="cmt-text">{c.body}</p>}
          {c.audio_path && c.audio_ms && <VoiceNote path={c.audio_path} ms={c.audio_ms} />}
          {c.video_path && <VideoNotePlayer path={c.video_path} ms={c.video_ms} />}
        </div>
        <div className="cmt-actions">
          <span>{timeAgo(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
          {depth === 0 && <button onClick={() => { setReplyTo(c); box.current?.focus() }}>Reply</button>}
          {(c.author === uid || postAuthor === uid) && <button onClick={() => remove(c)}>Delete</button>}
          {c.author !== uid && <button onClick={() => setReporting(c.id)}>Report</button>}
        </div>
        {kids(c.id).length > 0 && <ul className="cmt-list nested">{kids(c.id).map(k => <Item key={k.id} c={k} depth={1} />)}</ul>}
      </div>
    </li>
  ) }

  return (
    <section aria-label="Comments" className="cmts">
      <h2 className="t-section">Comments{roots.length ? ` (${(data ?? []).length})` : ''}</h2>
      {loading ? <Spinner /> : roots.length === 0 ? <p className="t-support" style={{ padding: '12px 0' }}>No comments yet. Start the conversation.</p>
        : <ul className="cmt-list">{roots.map(c => <Item key={c.id} c={c} depth={0} />)}</ul>}
      <div className="cmt-composer">
        {replyTo && <p className="cmt-replying">Replying to <b>{replyTo.profiles.display_name || replyTo.profiles.username}</b><button onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={16} /></button></p>}
        <div className="cmt-box">
          <textarea ref={box} className="cmt-input" aria-label="Write a comment" rows={1} value={body} maxLength={2000} placeholder={`Comment as ${me}`}
            onChange={e => { setBody(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px` }} />
          <div className="cmt-tools">
            <VoiceRecorder uid={uid!} onSend={sendVoice} disabled={busy} />
            <VideoNoteButton onSend={sendVideo} disabled={busy} />
            <span className="grow" />
            <button className="cmt-send" aria-label="Post comment" disabled={busy || !body.trim()} onClick={send}><Send size={20} /></button>
          </div>
        </div>
      </div>
      {reporting && <ReportSheet target={{ type: 'comment', id: reporting }} onClose={() => setReporting(null)} />}
    </section>
  )
}
