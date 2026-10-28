import { Emoji } from './Emoji'
import { useEffect, useRef, useState } from 'react'
import { Send, X } from 'lucide-react'
import { REACTIONS, type ReactionKey } from '../lib/social'
import { NameTick } from './VerifiedBadge'
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

interface C { id: string; author: string; parent_id: string | null; body: string; audio_path: string | null; audio_ms: number | null; video_path?: string | null; video_ms?: number | null; created_at: string; edited_at: string | null; profiles: PublicProfile
  /** Reactions (update 41): who reacted and with what. */
  rx?: { user_id: string; reaction: ReactionKey }[]
  /** Likes (update 32): a count, and whether I liked it. Only on a server before update 41. */
  likes?: { count: number }[]; mine_like?: { user_id: string }[] }

/** `dock`: on a phone the comment box sits directly on top of the bottom navigation (the post page). */
export function Comments({ postId, postAuthor, dock = false, off = false }: { postId: string; postAuthor: string; dock?: boolean; off?: boolean }) {
  const { uid, profile } = useAuth()
  const live = useLiveProfiles()
  const box = useRef<HTMLTextAreaElement>(null)
  const { data, loading, reload } = useAsync(async () => {
    const run = (cols: string, likes: 'kinds' | 'count' | false = 'kinds') => {
      let q = supabase.from('comments').select(`*, profiles:author(${cols})${likes === 'kinds' ? ', rx:comment_reactions(user_id,reaction)' : likes === 'count' ? ', likes:comment_reactions(count), mine_like:comment_reactions(user_id)' : ''}`).eq('post_id', postId)
      if (likes === 'count') q = q.eq('mine_like.user_id', uid!)
      return q.order('created_at').limit(200)
    }
    let { data, error } = await run('id,username,display_name,avatar_path,verified_until')
    if (error && isMissingSchema(error)) ({ data, error } = await run('id,username,display_name,avatar_path,verified_until', 'count'))
    if (error && isMissingSchema(error)) ({ data, error } = await run('id,username,display_name,avatar_path,verified_until', false))
    if (error && isMissingSchema(error)) ({ data, error } = await run('id,username,display_name,avatar_path', false))
    if (error) throw error
    return (data ?? []) as unknown as C[]
  }, [postId])
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<C | null>(null)
  const [reporting, setReporting] = useState<string | null>(null)
  const [busy, submit] = useSubmit()
  // My reaction on each comment as I change it, over what the server sent (optimistic; rolled back if the write fails).
  const [mineKey, setMineKey] = useState<Record<string, ReactionKey | null>>({})
  const [picking, setPicking] = useState<string | null>(null)
  useEffect(() => {
    if (!picking) return
    const close = (e: Event) => { if (!(e.target as HTMLElement).closest?.('.cmt-pick, .cmt-react')) setPicking(null) }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPicking(null)
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [picking])
  const myServerKey = (c: C): ReactionKey | null => c.rx ? (c.rx.find(r => r.user_id === uid)?.reaction ?? null) : c.mine_like?.length ? 'heart' : null
  /** Choose a reaction, or choose the same one again to take it back. */
  const react = async (c: C, key: ReactionKey) => {
    if (!uid) return
    setPicking(null)
    const was = c.id in mineKey ? mineKey[c.id] : myServerKey(c), want = was === key ? null : key
    setMineKey(m => ({ ...m, [c.id]: want })); playSound(want ? 'like' : 'unlike')
    const q = supabase.from('comment_reactions')
    const { error } = want === null ? await q.delete().eq('comment_id', c.id).eq('user_id', uid)
      : was === null ? await q.insert({ comment_id: c.id, user_id: uid, reaction: want })
      : await q.update({ reaction: want }).eq('comment_id', c.id).eq('user_id', uid)
    if (error && error.code !== '23505') { setMineKey(m => ({ ...m, [c.id]: was })); toast(isMissingSchema(error) ? 'Reacting to comments needs the latest update.' : errMsg(error)) }
  }

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
  const Item = ({ c: raw, depth }: { c: C; depth: number }) => {
    const c = { ...raw, profiles: live(raw.profiles) }
    const server = myServerKey(c), mine = c.id in mineKey ? mineKey[c.id] : server
    // Everyone's reactions, with mine counted as I have it now.
    const counts = new Map<ReactionKey, number>()
    for (const r of c.rx ?? []) if (r.user_id !== uid) counts.set(r.reaction, (counts.get(r.reaction) ?? 0) + 1)
    if (!c.rx && (c.likes?.[0]?.count ?? 0) - (server ? 1 : 0) > 0) counts.set('heart', (c.likes![0].count) - (server ? 1 : 0))
    if (mine) counts.set(mine, (counts.get(mine) ?? 0) + 1)
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    return (
    <li className={`cmt${depth ? ' reply' : ''}`}>
      <Link to={`/app/u/${c.profiles.username}`} aria-label={`${c.profiles.display_name || c.profiles.username} profile`}><Avatar size="sm" path={c.profiles.avatar_path} uid={c.author} name={c.profiles.display_name || c.profiles.username} /></Link>
      <div className="cmt-main">
        <div className="cmt-row">
        <div className="cmt-bubble">
          <Link to={`/app/u/${c.profiles.username}`} className="cmt-name"><NameTick name={c.profiles.display_name || c.profiles.username} profile={c.profiles} size={14} /></Link>
          {c.body && <p className="cmt-text">{c.body}</p>}
          {c.audio_path && c.audio_ms && <VoiceNote path={c.audio_path} ms={c.audio_ms} />}
          {c.video_path && <VideoNotePlayer path={c.video_path} ms={c.video_ms} />}
        </div>
        </div>
        <div className="cmt-actions">
          <span>{timeAgo(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
          <span className="cmt-react-wrap">
            <button className={`cmt-react${mine ? ' on' : ''}`} aria-haspopup="true" aria-expanded={picking === c.id} onClick={() => setPicking(p => (p === c.id ? null : c.id))}>
              {mine ? <><Emoji k={mine} size={15} label="" /> {REACTIONS.find(r => r.key === mine)!.label}</> : <>React</>}
            </button>
            {picking === c.id && (
              <div className="cmt-pick" role="group" aria-label="Choose a reaction">
                {REACTIONS.map(r => <button key={r.key} className={mine === r.key ? 'on' : ''} aria-pressed={mine === r.key} aria-label={r.label} onClick={() => void react(c, r.key)}><Emoji k={r.key} size={26} /></button>)}
              </div>
            )}
          </span>
          {depth === 0 && <button onClick={() => { setReplyTo(c); box.current?.focus() }}>Reply</button>}
          {(c.author === uid || postAuthor === uid) && <button onClick={() => remove(c)}>Delete</button>}
          {c.author !== uid && <button onClick={() => setReporting(c.id)}>Report</button>}
          {total > 0 && <span className="cmt-rx" aria-label={`${total} ${total === 1 ? 'reaction' : 'reactions'}: ${top.map(([k, n]) => `${n} ${REACTIONS.find(r => r.key === k)!.label}`).join(', ')}`}>{top.map(([k]) => <Emoji key={k} k={k} size={14} />)}<b>{total}</b></span>}
        </div>
        {kids(c.id).length > 0 && <ul className="cmt-list nested">{kids(c.id).map(k => <Item key={k.id} c={k} depth={1} />)}</ul>}
      </div>
    </li>
  ) }

  return (
    <section aria-label="Comments" className={`cmts${dock ? ' dock' : ''}`}>
      <h2 className="t-section">Comments{roots.length ? ` (${(data ?? []).length})` : ''}</h2>
      {loading ? <Spinner /> : roots.length === 0 ? <p className="t-support" style={{ padding: '12px 0' }}>No comments yet. Start the conversation.</p>
        : <ul className="cmt-list">{roots.map(c => <Item key={c.id} c={c} depth={0} />)}</ul>}
      {off ? <p className="cmt-off" role="status">The author turned off commenting on this post.</p> : <div className="cmt-composer">
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
      </div>}
      {reporting && <ReportSheet target={{ type: 'comment', id: reporting }} onClose={() => setReporting(null)} />}
    </section>
  )
}
