import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Send } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast } from '../ui'
import { timeAgo } from '../lib/format'
import type { PublicProfile } from '../lib/types'

interface Msg { id: string; conversation_id: string; sender: string; body: string; created_at: string; deleted_at: string | null; client_id?: string | null; pending?: boolean; failed?: boolean }

export default function Messages() {
  const { id } = useParams()
  useEffect(() => { document.title = 'Messages · VYBE' }, [])
  return id ? <Thread id={id} /> : <Inbox />
}

function Inbox() {
  const { uid } = useAuth()
  const list = useAsync(async () => {
    const { data: mine, error } = await supabase.from('conversation_members').select('conversation_id,last_read_at,conversations(id,is_group,title)').eq('user_id', uid!)
    if (error) throw error
    const convs = (mine ?? []) as unknown as { conversation_id: string; last_read_at: string; conversations: { id: string; is_group: boolean; title: string | null } }[]
    if (!convs.length) return []
    const ids = convs.map(c => c.conversation_id)
    const [msgs, people] = await Promise.all([
      supabase.from('messages').select('id,conversation_id,sender,body,created_at,deleted_at').in('conversation_id', ids).order('created_at', { ascending: false }).limit(300),
      supabase.from('conversation_members').select('conversation_id,profiles:user_id(id,username,display_name,avatar_path)').in('conversation_id', ids).neq('user_id', uid!),
    ])
    if (msgs.error) throw msgs.error
    const m = (msgs.data ?? []) as Msg[]
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

  useEffect(() => {
    const ch = supabase.channel(`inbox:${uid}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => list.reload()).subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])

  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 12 }}>Messages</h1>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title="No conversations yet">Open a friend's profile and tap Message to start chatting.</Empty>
      ) : (
        <div className="list">{list.data.map(c => (
          <Link key={c.id} to={`/app/messages/${c.id}`} className="item row link">
            <Avatar path={c.avatar?.avatar_path} name={c.title} />
            <div className="grow"><div className="t-name clamp-1">{c.title}</div><div className="t-meta clamp-1">{c.last ? (c.last.deleted_at ? 'Message deleted' : c.last.body) : 'No messages yet'}</div></div>
            <div style={{ textAlign: 'right' }}>{c.last && <div className="t-meta">{timeAgo(c.last.created_at)}</div>}{c.unread > 0 && <span className="badge" style={{ marginLeft: 'auto' }}>{c.unread}</span>}</div>
          </Link>))}</div>
      )}
    </>
  )
}

function Thread({ id }: { id: string }) {
  const { uid } = useAuth()
  const nav = useNavigate()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [text, setText] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'missing'>('loading')
  const [error, setError] = useState('')
  const [online, setOnline] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)
  const names = useAsync(async () => {
    const { data } = await supabase.from('conversation_members').select('profiles:user_id(id,username,display_name,avatar_path)').eq('conversation_id', id).neq('user_id', uid!)
    return ((data ?? []) as unknown as { profiles: PublicProfile }[]).map(x => x.profiles)
  }, [id])

  const markRead = () => supabase.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', id).eq('user_id', uid!).then(() => {})

  // Merge by id (server rows win) and by client_id (replaces optimistic copies): delivery can repeat or arrive out of order.
  const merge = (incoming: Msg[]) => setMsgs(cur => {
    const byId = new Map<string, Msg>()
    for (const m of cur) if (!incoming.some(i => i.id === m.id || (i.client_id && i.client_id === m.client_id))) byId.set(m.id, m)
    for (const m of incoming) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  })

  const load = async () => {
    const { data, error } = await supabase.from('messages').select('id,conversation_id,sender,body,created_at,deleted_at,client_id').eq('conversation_id', id).order('created_at', { ascending: false }).limit(60)
    if (error) { setError(errMsg(error)); setState('error'); return }
    const { data: c } = await supabase.from('conversations').select('id').eq('id', id).maybeSingle()
    if (!c) return setState('missing')
    merge((data ?? []) as Msg[]); setState('ready'); markRead()
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

  const send = async (body: string, clientId: string = crypto.randomUUID()) => {
    const optimistic: Msg = { id: clientId, client_id: clientId, conversation_id: id, sender: uid!, body, created_at: new Date().toISOString(), deleted_at: null, pending: true }
    setMsgs(c => [...c.filter(m => m.client_id !== clientId), optimistic])
    const { data, error } = await supabase.from('messages').insert({ conversation_id: id, sender: uid, body, client_id: clientId }).select('id,conversation_id,sender,body,created_at,deleted_at,client_id').single()
    if (error) {
      if (error.code === '23505') { load(); return } // duplicate client_id: it was already delivered
      setMsgs(c => c.map(m => (m.client_id === clientId ? { ...m, pending: false, failed: true } : m)))
      return toast(error.message.includes('rate limit') ? 'Slow down a little.' : 'Message failed to send')
    }
    merge([data as Msg])
  }
  const submit = (e: FormEvent) => { e.preventDefault(); const b = text.trim(); if (!b) return; setText(''); send(b) }
  const remove = async (m: Msg) => {
    if (!confirm('Delete this message for everyone?')) return
    const { error } = await supabase.from('messages').update({ deleted_at: new Date().toISOString(), body: 'Message deleted' }).eq('id', m.id)
    if (error) toast(errMsg(error))
  }

  const title = names.data?.map(n => n.display_name || n.username).join(', ') || 'Conversation'
  if (state === 'missing') return <Empty title="Conversation not found">You may not be a member of this conversation.</Empty>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - var(--nav-h) * 2 - 24px)' }}>
      <div className="row" style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
        <button className="icon-btn" aria-label="Back to messages" onClick={() => nav('/app/messages')}><ArrowLeft size={22} /></button>
        <Avatar size="sm" path={names.data?.[0]?.avatar_path} name={title} /><h1 className="t-section clamp-1">{title}</h1>
      </div>
      {!online && <p className="notice err" role="status" style={{ marginTop: 8 }}>You're offline. Messages will send when you reconnect — tap a failed message to retry.</p>}
      <div className="grow stack" style={{ gap: 6, padding: '12px 0', alignContent: 'end' }} aria-live="polite">
        {state === 'loading' ? <Spinner /> : state === 'error' ? <ErrorState message={error} onRetry={load} /> : msgs.length === 0 ? <p className="t-support" style={{ textAlign: 'center' }}>Say hello 👋</p> : msgs.map(m => {
          const mine = m.sender === uid
          return (
            <div key={m.id} style={{ justifySelf: mine ? 'end' : 'start', maxWidth: '82%' }}>
              <div onClick={() => m.failed ? send(m.body, m.client_id ?? undefined) : undefined}
                style={{ padding: '8px 12px', borderRadius: 16, background: mine ? 'var(--brand)' : 'var(--surface-2)', color: mine ? 'var(--on-brand)' : 'var(--text)', opacity: m.pending ? .6 : 1, fontStyle: m.deleted_at ? 'italic' : undefined, whiteSpace: 'pre-wrap', cursor: m.failed ? 'pointer' : undefined }}>
                {m.body}
              </div>
              <div className="t-meta" style={{ textAlign: mine ? 'right' : 'left' }}>{m.failed ? 'Failed — tap to retry' : m.pending ? 'Sending…' : timeAgo(m.created_at)}{mine && !m.pending && !m.failed && !m.deleted_at && <> · <button className="btn ghost sm" style={{ minHeight: 28, padding: '0 6px' }} onClick={() => remove(m)}>Delete</button></>}</div>
            </div>
          )
        })}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit} className="row" style={{ position: 'sticky', bottom: 'calc(var(--nav-h) + env(safe-area-inset-bottom))', background: 'var(--bg)', paddingTop: 8 }}>
        <input className="input" aria-label="Message" placeholder="Message" value={text} onChange={e => setText(e.target.value)} maxLength={4000} autoComplete="off" />
        <button className="icon-btn" aria-label="Send message" disabled={!text.trim()}><Send size={22} /></button>
      </form>
      <p className="t-meta" style={{ marginTop: 4 }}>Messages are private to this conversation but not end-to-end encrypted.</p>
    </div>
  )
}
