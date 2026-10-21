import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, ChevronRight, Image as ImageIcon, Plus, Search, Send, SquarePen, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { useChromeless } from '../lib/chrome'
import { Avatar, Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import { friendIds } from '../lib/posts'
import { timeAgo } from '../lib/format'
import { compactNumber, profileStats, type Stats } from '../lib/social'
import { uploadMedia, validateMedia } from '../lib/media'
import { isMissingSchema } from '../lib/tickets'
import { VoiceNote, VoiceRecorder } from '../components/VoiceNote'
import { FollowButton } from '../components/discover/FollowButton'
import { VerifiedBadge } from '../components/VerifiedBadge'
import { loadSuggestions, type Suggestion } from './People'
import { playSound } from '../lib/sounds'
import type { PublicProfile } from '../lib/types'

interface Msg {
  id: string; conversation_id: string; sender: string; body: string; created_at: string; deleted_at: string | null; client_id?: string | null
  media_path?: string | null; media_type?: 'image' | 'video' | null; audio_path?: string | null; audio_ms?: number | null
  pending?: boolean; failed?: boolean; preview?: string
}
const BASE_COLS = 'id,conversation_id,sender,body,created_at,deleted_at,client_id'
const MEDIA_COLS = `${BASE_COLS},media_path,media_type,audio_path,audio_ms`
const preview = (m?: Msg, mine = false) => !m ? 'No messages yet' : m.deleted_at ? 'Message deleted' : m.body ? `${mine ? 'You: ' : ''}${m.body}` : m.audio_path ? `${mine ? 'You sent' : 'Sent'} a voice message` : m.media_type === 'video' ? `${mine ? 'You sent' : 'Sent'} a video` : m.media_path ? `${mine ? 'You sent' : 'Sent'} a photo` : ''

export default function Messages() {
  const { id } = useParams()
  useEffect(() => { document.title = 'Messages · VYBE' }, [])
  return id ? <Thread id={id} /> : <Inbox />
}

/* ------------------------------------------------------------------ inbox */
function Inbox() {
  const { uid } = useAuth()
  const nav = useNavigate()
  const [grouping, setGrouping] = useState(false)
  const [q, setQ] = useState('')
  const list = useAsync(async () => {
    const { data: mine, error } = await supabase.from('conversation_members').select('conversation_id,last_read_at,conversations(id,is_group,title)').eq('user_id', uid!)
    if (error) throw error
    const convs = (mine ?? []) as unknown as { conversation_id: string; last_read_at: string; conversations: { id: string; is_group: boolean; title: string | null } }[]
    if (!convs.length) return []
    const ids = convs.map(c => c.conversation_id)
    const run = (cols: string) => supabase.from('messages').select(cols).in('conversation_id', ids).order('created_at', { ascending: false }).limit(300)
    let msgs = await run(MEDIA_COLS)
    if (msgs.error && isMissingSchema(msgs.error)) msgs = await run(BASE_COLS)
    const people = await supabase.from('conversation_members').select('conversation_id,profiles:user_id(id,username,display_name,avatar_path)').in('conversation_id', ids).neq('user_id', uid!)
    if (msgs.error) throw msgs.error
    const m = (msgs.data ?? []) as unknown as Msg[]
    const p = (people.data ?? []) as unknown as { conversation_id: string; profiles: PublicProfile }[]
    return convs.map(c => {
      const mm = m.filter(x => x.conversation_id === c.conversation_id)
      const others = p.filter(x => x.conversation_id === c.conversation_id).map(x => x.profiles)
      return {
        id: c.conversation_id, title: c.conversations.title || others.map(o => o.display_name || o.username).join(', ') || 'Conversation',
        avatar: others[0], last: mm[0], unread: mm.filter(x => x.sender !== uid && x.created_at > c.last_read_at).length,
      }
    }).sort((a, b) => (b.last?.created_at ?? '').localeCompare(a.last?.created_at ?? ''))
  }, [uid])
  const suggestions = useAsync(async () => { try { return (await loadSuggestions(8)) ?? [] } catch { return [] as Suggestion[] } }, [uid])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    const ch = supabase.channel(`inbox:${uid}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => list.reload()).subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])
  const shown = useMemo(() => (list.data ?? []).filter(c => c.title.toLowerCase().includes(q.trim().toLowerCase())), [list.data, q])
  const accounts = (suggestions.data ?? []).filter(s => !dismissed.has(s.id)).slice(0, 5)

  return (
    <div className="dm-inbox">
      <div className="row between" style={{ marginBottom: 12, alignItems: 'center' }}>
        <h1 className="t-title">Messages</h1>
        <button className="icon-btn" aria-label="New group" onClick={() => setGrouping(true)}><SquarePen size={24} /></button>
      </div>
      <label className="cp-search"><Search size={18} aria-hidden /><input type="search" aria-label="Search messages" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} /></label>
      {grouping && <GroupSheet onClose={() => setGrouping(false)} onCreated={id => nav(`/app/messages/${id}`)} />}
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !shown.length ? (
        q ? <p className="t-support" style={{ padding: '12px 0' }}>No conversations match “{q}”.</p> : <p className="dm-empty">Chats will appear here after you send or receive a message. <Link to="/app/people">Get started</Link></p>
      ) : (
        <ul className="dm-list">{shown.map(c => {
          const fromMe = c.last?.sender === uid
          return (
            <li key={c.id}><Link to={`/app/messages/${c.id}`} className="dm-row">
              <Avatar size="lg" path={c.avatar?.avatar_path} name={c.title} />
              <span className="dm-mid"><span className={`dm-name${c.unread ? ' unread' : ''}`}>{c.title}</span>
                <span className={`dm-last${c.unread ? ' unread' : ''}`}><span className="clamp-1">{preview(c.last, fromMe)}</span>{c.last && <span> · {timeAgo(c.last.created_at)}</span>}</span></span>
              {c.unread > 0 && <span className="dm-dot" aria-label={`${c.unread} unread`} />}
            </Link></li>)
        })}</ul>
      )}
      {accounts.length > 0 && (
        <section className="dm-follow" aria-labelledby="dm-acc">
          <div className="row between" style={{ alignItems: 'center' }}><h2 id="dm-acc" className="t-section">Accounts to follow</h2><Link to="/app/people" className="dm-seeall">See all</Link></div>
          <ul className="ppl-list">{accounts.map(a => (
            <li key={a.id} className="ppl-row">
              <Link to={`/app/u/${a.username}`} className="ppl-link"><Avatar size="lg" path={a.avatar_path} name={a.display_name || a.username} />
                <span className="ppl-text"><span className="ppl-name">{a.display_name || a.username}<VerifiedBadge profile={a} /></span><span className="t-meta clamp-1">{a.follows_me ? 'Follows you' : a.mutual ? `${a.mutual} mutual ${a.mutual === 1 ? 'friend' : 'friends'}` : `@${a.username}`}</span></span></Link>
              <FollowButton type="profile" id={a.id} following={false} size="md" idleText={a.follows_me ? 'Follow back' : 'Follow'} label={a.display_name || a.username} className="ppl-follow" />
              <button className="icon-btn" aria-label={`Dismiss ${a.display_name || a.username}`} onClick={() => setDismissed(d => new Set(d).add(a.id))}><X size={18} /></button>
            </li>))}</ul>
        </section>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ thread */
function Bubble({ m, mine, onRetry, onDelete }: { m: Msg; mine: boolean; onRetry: () => void; onDelete: () => void }) {
  const url = useSigned(m.media_path)
  const local = m.preview
  const src = local ?? url
  const onlyMedia = !m.body && (m.media_path || m.audio_path)
  return (
    <div className={`dm-msg${mine ? ' mine' : ''}`}>
      <div className={`dm-bubble${m.pending ? ' pending' : ''}${onlyMedia ? ' bare' : ''}${m.deleted_at ? ' deleted' : ''}`} onClick={() => (m.failed ? onRetry() : undefined)}>
        {m.media_path && !m.deleted_at && (src ? (m.media_type === 'video' ? <video src={src} controls playsInline preload="metadata" /> : <img src={src} alt="Photo in this chat" loading="lazy" decoding="async" />) : <span className="skeleton" style={{ display: 'block', width: 200, height: 240 }} aria-hidden />)}
        {m.audio_path && m.audio_ms && !m.deleted_at && <VoiceNote path={m.audio_path} ms={m.audio_ms} />}
        {m.body && <span className="dm-text">{m.body}</span>}
      </div>
      <div className="dm-meta">{m.failed ? 'Failed — tap to retry' : m.pending ? 'Sending…' : timeAgo(m.created_at)}{mine && !m.pending && !m.failed && !m.deleted_at && <> · <button className="linklike" onClick={onDelete}>Delete</button></>}</div>
    </div>
  )
}

function Thread({ id }: { id: string }) {
  const { uid } = useAuth()
  const nav = useNavigate()
  useChromeless()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'missing'>('loading')
  const [error, setError] = useState('')
  const [online, setOnline] = useState(true)
  const bottom = useRef<HTMLDivElement>(null), camera = useRef<HTMLInputElement>(null), gallery = useRef<HTMLInputElement>(null)
  const names = useAsync(async () => {
    const { data } = await supabase.from('conversation_members').select('profiles:user_id(id,username,display_name,avatar_path,verified_until)').eq('conversation_id', id).neq('user_id', uid!)
    return ((data ?? []) as unknown as { profiles: PublicProfile }[]).map(x => x.profiles)
  }, [id])
  const conv = useAsync(async () => { const { data } = await supabase.from('conversations').select('id,is_group,title').eq('id', id).maybeSingle(); return data as { id: string; is_group: boolean; title: string | null } | null }, [id])
  const other = !conv.data?.is_group ? names.data?.[0] : undefined
  const stats = useAsync<Stats | null>(() => (other ? profileStats(other.id) : Promise.resolve(null)), [other?.id])

  const markRead = () => supabase.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', id).eq('user_id', uid!).then(() => {})

  // Merge by id (server rows win) and by client_id (replaces optimistic copies): delivery can repeat or arrive out of order.
  const merge = (incoming: Msg[]) => setMsgs(cur => {
    const byId = new Map<string, Msg>()
    for (const m of cur) if (!incoming.some(i => i.id === m.id || (i.client_id && i.client_id === m.client_id))) byId.set(m.id, m)
    for (const m of incoming) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  })

  const load = async () => {
    const run = (cols: string) => supabase.from('messages').select(cols).eq('conversation_id', id).order('created_at', { ascending: false }).limit(60)
    let r = await run(MEDIA_COLS)
    if (r.error && isMissingSchema(r.error)) r = await run(BASE_COLS)
    if (r.error) { setError(errMsg(r.error)); setState('error'); return }
    const { data: c } = await supabase.from('conversations').select('id').eq('id', id).maybeSingle()
    if (!c) return setState('missing')
    merge((r.data ?? []) as unknown as Msg[]); setState('ready'); markRead()
  }

  useEffect(() => {
    setMsgs([]); setState('loading'); load()
    const ch = supabase.channel(`thread:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` }, p => { merge([p.new as Msg]); if ((p.new as Msg).sender !== uid) markRead() })
      .subscribe(status => { if (status === 'SUBSCRIBED') load() }) // refetch after (re)connect to fill any gap
    const on = () => { setOnline(true); load() }, off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { supabase.removeChannel(ch); window.removeEventListener('online', on); window.removeEventListener('offline', off) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [msgs.length])

  const deliver = async (draft: Partial<Msg> & { body: string }, clientId: string = crypto.randomUUID()) => {
    const optimistic: Msg = { id: clientId, client_id: clientId, conversation_id: id, sender: uid!, created_at: new Date().toISOString(), deleted_at: null, pending: true, ...draft }
    setMsgs(c => [...c.filter(m => m.client_id !== clientId), optimistic])
    const row = { conversation_id: id, sender: uid, body: draft.body, client_id: clientId, ...(draft.media_path ? { media_path: draft.media_path, media_type: draft.media_type } : {}), ...(draft.audio_path ? { audio_path: draft.audio_path, audio_ms: draft.audio_ms } : {}) }
    const { data, error } = await supabase.from('messages').insert(row).select(MEDIA_COLS).single()
    if (error) {
      if (error.code === '23505') { load(); return } // duplicate client_id: it was already delivered
      setMsgs(c => c.map(m => (m.client_id === clientId ? { ...m, pending: false, failed: true } : m)))
      return toast(error.message.includes('rate limit') ? 'Slow down a little.' : 'Message failed to send')
    }
    playSound('send'); merge([data as unknown as Msg])
  }
  const sendFile = async (f?: File) => {
    if (!f || !uid) return
    const c = validateMedia(f); if (!c.ok) return toast(c.error)
    const cid = crypto.randomUUID(), local = URL.createObjectURL(f)
    setMsgs(cur => [...cur, { id: cid, client_id: cid, conversation_id: id, sender: uid, body: '', created_at: new Date().toISOString(), deleted_at: null, pending: true, media_type: c.type, preview: local }])
    try { const up = await uploadMedia(uid, f); await deliver({ body: '', media_path: up.path, media_type: up.type }, cid) } catch (e) { setMsgs(cur => cur.filter(m => m.id !== cid)); toast(errMsg(e)) }
  }
  const sendVoice = async (a: { path: string; ms: number }) => { await deliver({ body: '', audio_path: a.path, audio_ms: a.ms }) }
  const submit = (e: FormEvent) => { e.preventDefault(); const b = text.trim(); if (!b) return; setText(''); void deliver({ body: b }) }
  const remove = async (m: Msg) => {
    if (!confirm('Delete this message for everyone?')) return
    const { error } = await supabase.from('messages').update({ deleted_at: new Date().toISOString(), body: 'Message deleted' }).eq('id', m.id)
    if (error) toast(errMsg(error))
  }

  const title = conv.data?.title || names.data?.map(n => n.display_name || n.username).join(', ') || 'Conversation'
  if (state === 'missing') return <Empty title="Conversation not found">You may not be a member of this conversation.</Empty>
  return (
    <div className="dm">
      <header className="dm-head">
        <button className="icon-btn" aria-label="Back to messages" onClick={() => nav('/app/messages')}><ArrowLeft size={24} /></button>
        {other
          ? <Link to={`/app/u/${other.username}`} className="dm-who"><Avatar size="sm" path={other.avatar_path} name={title} /><span className="dm-who-t"><b>{title}<VerifiedBadge profile={other} /></b><span>@{other.username}</span></span><ChevronRight size={16} aria-hidden /></Link>
          : <div className="dm-who"><Avatar size="sm" path={names.data?.[0]?.avatar_path} name={title} /><span className="dm-who-t"><b>{title}</b><span>{(names.data?.length ?? 0) + 1} people</span></span></div>}
      </header>
      {!online && <p className="notice err" role="status" style={{ margin: 8 }}>You're offline. Messages will send when you reconnect — tap a failed message to retry.</p>}
      <div className="dm-scroll" aria-live="polite">
        {other && (
          <div className="dm-intro">
            <Link to={`/app/u/${other.username}`} aria-label={`${title} profile`}><Avatar size="lg" path={other.avatar_path} name={title} /></Link>
            <h1 className="dm-intro-name">{title}<VerifiedBadge profile={other} size={18} /></h1>
            <span className="dm-intro-handle">@{other.username}</span>
            <span className="dm-intro-stats">{stats.data?.followers != null ? `${compactNumber(stats.data.followers)} followers · ` : ''}{stats.data?.posts != null ? `${compactNumber(stats.data.posts)} posts` : ''}</span>
            {stats.data?.follows_me && <span className="dm-intro-stats">Follows you</span>}
          </div>
        )}
        {state === 'loading' ? <Spinner /> : state === 'error' ? <ErrorState message={error} onRetry={load} /> : msgs.length === 0 ? <p className="t-support" style={{ textAlign: 'center' }}>Say hello 👋</p> : msgs.map(m => (
          <Bubble key={m.id} m={m} mine={m.sender === uid} onRetry={() => void deliver({ body: m.body, media_path: m.media_path, media_type: m.media_type, audio_path: m.audio_path, audio_ms: m.audio_ms }, m.client_id ?? undefined)} onDelete={() => void remove(m)} />
        ))}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit} className="dm-bar">
        <button type="button" className="dm-cam" aria-label="Take a photo or video" onClick={() => camera.current?.click()}><Camera size={22} /></button>
        <input className="dm-input" aria-label="Message" placeholder="Message…" value={text} onChange={e => setText(e.target.value)} maxLength={4000} autoComplete="off" />
        {text.trim()
          ? <button className="dm-send" aria-label="Send message"><Send size={20} /></button>
          : <span className="dm-tools"><VoiceRecorder uid={uid!} onSend={sendVoice} /><button type="button" className="icon-btn" aria-label="Send a photo or video from your gallery" onClick={() => gallery.current?.click()}><ImageIcon size={24} /></button><button type="button" className="icon-btn" aria-label="More" onClick={() => toast('Photos, videos and voice notes are supported.')}><Plus size={26} /></button></span>}
      </form>
      <input ref={camera} type="file" hidden accept="image/*,video/*" capture="environment" onChange={e => { void sendFile(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={gallery} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={e => { void sendFile(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

function GroupSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { uid } = useAuth()
  const [title, setTitle] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [busy, submit] = useSubmit()
  const friends = useAsync(async () => {
    const ids = await friendIds(uid!)
    if (!ids.length) return [] as PublicProfile[]
    const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path').in('id', ids)
    return (data ?? []) as PublicProfile[]
  }, [uid])
  const create = () => submit(async () => {
    const { data, error } = await supabase.rpc('start_group', { title: title.trim() || 'New group', members: sel })
    if (error) return toast(errMsg(error))
    onClose(); onCreated(data as string)
  })
  return (
    <Sheet title="New group" onClose={onClose}>
      <Field id="g-title" label="Group name"><input id="g-title" className="input" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} /></Field>
      <p className="t-meta" style={{ marginBottom: 8 }}>Only your friends can be added to a group.</p>
      {friends.loading ? <Spinner /> : !friends.data?.length ? <p className="t-support">Add some friends first.</p> : (
        <div className="list" style={{ maxHeight: '40vh', overflow: 'auto' }}>{friends.data.map(f => (
          <label key={f.id} className="item row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.includes(f.id)} onChange={() => setSel(c => c.includes(f.id) ? c.filter(x => x !== f.id) : c.length < 48 ? [...c, f.id] : c)} />
            <Avatar size="sm" path={f.avatar_path} name={f.display_name || f.username} /><span>{f.display_name || f.username}</span>
          </label>))}</div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !sel.length} onClick={create}>Create group</button></div>
    </Sheet>
  )
}
