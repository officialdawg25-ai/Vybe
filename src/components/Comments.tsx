import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Avatar, Spinner, errMsg, toast } from '../ui'
import { timeAgo } from '../lib/format'
import { ReportSheet } from './Report'
import { VoiceNote, VoiceRecorder } from './VoiceNote'
import { playSound } from '../lib/sounds'
import type { PublicProfile } from '../lib/types'

interface C { id: string; author: string; parent_id: string | null; body: string; audio_path: string | null; audio_ms: number | null; created_at: string; edited_at: string | null; profiles: PublicProfile }

export function Comments({ postId, postAuthor }: { postId: string; postAuthor: string }) {
  const { uid } = useAuth()
  const { data, loading, reload } = useAsync(async () => {
    const { data, error } = await supabase.from('comments').select('*, profiles:author(id,username,display_name,avatar_path)').eq('post_id', postId).order('created_at').limit(200)
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
  const remove = async (c: C) => {
    if (!confirm('Delete this comment?')) return
    const { error } = await supabase.from('comments').delete().eq('id', c.id)
    if (error) return toast(errMsg(error))
    if (c.audio_path && c.author === uid) await supabase.storage.from('media').remove([c.audio_path])
    reload()
  }

  const roots = (data ?? []).filter(c => !c.parent_id)
  const kids = (id: string) => (data ?? []).filter(c => c.parent_id === id)
  const Item = ({ c, depth }: { c: C; depth: number }) => (
    <div style={{ marginLeft: depth ? 28 : 0 }} className="item">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Avatar size="sm" path={c.profiles.avatar_path} name={c.profiles.display_name || c.profiles.username} />
        <div className="grow">
          <div className="t-meta"><Link to={`/app/u/${c.profiles.username}`} className="t-name" style={{ color: 'var(--text)' }}>{c.profiles.display_name || c.profiles.username}</Link> · {timeAgo(c.created_at)}</div>
          {c.body && <p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p>}
          {c.audio_path && c.audio_ms && <VoiceNote path={c.audio_path} ms={c.audio_ms} />}
          <div className="row" style={{ gap: 12 }}>
            {depth === 0 && <button className="btn ghost sm" onClick={() => setReplyTo(c)}>Reply</button>}
            {(c.author === uid || postAuthor === uid) && <button className="btn ghost sm" onClick={() => remove(c)}>Delete</button>}
            {c.author !== uid && <button className="btn ghost sm" onClick={() => setReporting(c.id)}>Report</button>}
          </div>
        </div>
      </div>
      {kids(c.id).map(k => <Item key={k.id} c={k} depth={1} />)}
    </div>
  )

  return (
    <section aria-label="Comments" style={{ marginTop: 8 }}>
      <h2 className="t-section">Comments</h2>
      {loading ? <Spinner /> : roots.length === 0 ? <p className="t-support" style={{ padding: '12px 0' }}>No comments yet. Start the conversation.</p>
        : <div className="list">{roots.map(c => <Item key={c.id} c={c} depth={0} />)}</div>}
      <div className="stack" style={{ gap: 8, marginTop: 12 }}>
        {replyTo && <p className="t-meta">Replying to {replyTo.profiles.username} · <button className="btn ghost sm" onClick={() => setReplyTo(null)}>Cancel</button></p>}
        <textarea className="textarea" aria-label="Write a comment" style={{ minHeight: 60 }} value={body} onChange={e => setBody(e.target.value)} maxLength={2000} placeholder="Write a comment…" />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <VoiceRecorder uid={uid!} onSend={sendVoice} disabled={busy} />
          <button className="btn primary sm" disabled={busy || !body.trim()} onClick={send}>Comment</button>
        </div>
      </div>
      {reporting && <ReportSheet target={{ type: 'comment', id: reporting }} onClose={() => setReporting(null)} />}
    </section>
  )
}
