import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Camera, ChevronRight, Download, File as FileIcon, Image as ImageIcon, Lock, Paperclip, Phone, Plus, Search, Send, ShieldAlert, SquarePen, Video, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { useChromeless } from '../lib/chrome'
import { Avatar, Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import { friendIds } from '../lib/posts'
import { timeAgo } from '../lib/format'
import { compactNumber, profileStats, type Stats } from '../lib/social'
import { MAX_FILE_BYTES, fileSize, signedFileUrl, uploadAttachment, uploadMedia, validateAttachment, validateMedia } from '../lib/media'
import { CameraCapture } from '../components/CameraCapture'
import { useCalls } from '../components/CallProvider'
import { ChatKeySheet } from '../components/ChatKeySheet'
import { getConversationKey, peerPublicKeys, useChatKeys } from '../lib/chatKeys'
import { decryptEnvelope, type Envelope } from '../lib/e2ee'
import { openAttachment, uploadEncrypted, useAttachmentUrl, useSecureChat } from '../lib/secureChat'
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
  file_path?: string | null; file_name?: string | null; file_size?: number | null; file_mime?: string | null; e2ee?: boolean
  pending?: boolean; failed?: boolean; preview?: string
}
const BASE_COLS = 'id,conversation_id,sender,body,created_at,deleted_at,client_id'
const MEDIA_COLS = `${BASE_COLS},media_path,media_type,audio_path,audio_ms`
const FILE_COLS = `${MEDIA_COLS},file_path,file_name,file_size,file_mime,e2ee`
/** Reads with the newest columns first and steps down for databases that have not had the latest migration yet. */
async function selectMessages(build: (cols: string) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>) {
  for (const cols of [FILE_COLS, MEDIA_COLS, BASE_COLS]) { const r = await build(cols); if (!r.error || !isMissingSchema(r.error as never)) return r }
  return build(BASE_COLS)
}
const preview = (m?: Msg, mine = false, secure?: string) => !m ? 'No messages yet' : m.deleted_at ? 'Message deleted' : m.e2ee ? `🔒 ${secure ? `${mine ? 'You: ' : ''}${secure}` : 'Encrypted message'}` : m.body ? `${mine ? 'You: ' : ''}${m.body}` : m.audio_path ? `${mine ? 'You sent' : 'Sent'} a voice message` : m.file_path ? `${mine ? 'You sent' : 'Sent'} a file` : m.media_type === 'video' ? `${mine ? 'You sent' : 'Sent'} a video` : m.media_path ? `${mine ? 'You sent' : 'Sent'} a photo` : ''

/** One-line description of a decrypted message for the inbox. */
const envLabel = (e: Envelope) => e.t === 'text' ? e.m.slice(0, 80) : e.t === 'media' ? (e.kind === 'video' ? 'Sent a video' : 'Sent a photo') : e.t === 'voice' ? 'Sent a voice message' : 'Sent a file'

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
    const msgs = await selectMessages(cols => supabase.from('messages').select(cols).in('conversation_id', ids).order('created_at', { ascending: false }).limit(300))
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
  // Last messages of encrypted chats are readable here once this device holds the member's keys.
  const keys = useChatKeys()
  const [secure, setSecure] = useState<Record<string, string>>({})
  useEffect(() => {
    const rows = (list.data ?? []).filter(c => c.last?.e2ee && !c.last.deleted_at && c.avatar)
    if (!rows.length || keys.state !== 'ready' || !keys.privateKey || !keys.publicKey || !uid) return
    let live = true
    ;(async () => {
      const pubs = await peerPublicKeys(rows.map(c => c.avatar!.id)), out: Record<string, string> = {}
      for (const c of rows) {
        const pub = pubs.get(c.avatar!.id); if (!pub) continue
        try { out[c.id] = envLabel(await decryptEnvelope(await getConversationKey(keys.privateKey!, keys.publicKey!, pub, c.id, uid, c.avatar!.id), c.last!.body, c.id, c.last!.sender)) } catch { /* shows "Encrypted message" */ }
      }
      if (live) setSecure(out)
    })()
    return () => { live = false }
  }, [list.data, keys.state, keys.version, keys.privateKey, keys.publicKey, uid])
  const suggestions = useAsync(async () => { try { return (await loadSuggestions(8)) ?? [] } catch { return [] as Suggestion[] } }, [uid])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Listen only to this member's own conversations (filtered server-side), not to every message on the platform.
  const convIds = (list.data ?? []).map(c => c.id).slice(0, 100).join(',')
  useEffect(() => {
    if (!convIds) return
    const ch = supabase.channel(`inbox:${uid}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=in.(${convIds})` }, () => list.reload()).subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, convIds])
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
              <Avatar size="lg" path={c.avatar?.avatar_path} uid={c.avatar?.id} name={c.title} />
              <span className="dm-mid"><span className={`dm-name${c.unread ? ' unread' : ''}`}>{c.title}</span>
                <span className={`dm-last${c.unread ? ' unread' : ''}`}><span className="clamp-1">{preview(c.last, fromMe, secure[c.id])}</span>{c.last && <span> · {timeAgo(c.last.created_at)}</span>}</span></span>
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
function FileCard({ m }: { m: Msg }) {
  const [busy, setBusy] = useState(false)
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy || !m.file_path) return
    setBusy(true)
    try { const u = await signedFileUrl(m.file_path, m.file_name ?? undefined); if (!u) throw new Error('Could not open this file'); window.open(u, '_blank', 'noopener') } catch (err) { toast(errMsg(err)) } finally { setBusy(false) }
  }
  return (
    <button type="button" className="dm-file" onClick={open} aria-label={`Download ${m.file_name ?? 'file'}${m.file_size ? `, ${fileSize(m.file_size)}` : ''}`}>
      <span className="dm-file-ico" aria-hidden><FileIcon size={22} /></span>
      <span className="dm-file-t"><b className="clamp-1">{m.file_name}</b><small>{m.file_size ? fileSize(m.file_size) : 'File'}{m.file_mime ? ` · ${(m.file_mime.split('/')[1] ?? '').toUpperCase().slice(0, 8)}` : ''}</small></span>
      <Download size={18} aria-hidden />
    </button>
  )
}

type Plain = Envelope | 'locked'

function SecureMedia({ m, env }: { m: Msg; env: Extract<Envelope, { t: 'media' }> }) {
  const { url, failed } = useAttachmentUrl(m.preview ? null : m.file_path, env.key ? env : null)
  const src = m.preview ?? url
  if (failed) return <span className="dm-text dm-lock">🔒 Could not open this {env.kind}.</span>
  if (!src) return <span className="skeleton" style={{ display: 'block', width: 200, height: 240 }} aria-label="Decrypting" />
  return env.kind === 'video' ? <video src={src} controls playsInline preload="metadata" /> : <img src={src} alt="Photo in this chat" decoding="async" />
}
function SecureVoice({ m, env }: { m: Msg; env: Extract<Envelope, { t: 'voice' }> }) {
  const { url } = useAttachmentUrl(m.file_path, env.key ? env : null)
  return <VoiceNote path={m.file_path ?? ''} ms={env.ms} src={m.preview ?? url} />
}
function SecureFile({ m, env }: { m: Msg; env: Extract<Envelope, { t: 'file' }> }) {
  const [busy, setBusy] = useState(false)
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy || !m.file_path || !env.key) return
    setBusy(true)
    try {
      const u = await openAttachment(m.file_path, env.key, env.iv, env.mime)
      const a = document.createElement('a'); a.href = u; a.download = env.name; document.body.appendChild(a); a.click(); a.remove()
    } catch (err) { toast(errMsg(err)) } finally { setBusy(false) }
  }
  return (
    <button type="button" className="dm-file" onClick={open} aria-label={`Download ${env.name}, ${fileSize(env.size)}`}>
      <span className="dm-file-ico" aria-hidden><FileIcon size={22} /></span>
      <span className="dm-file-t"><b className="clamp-1">{env.name}</b><small>{fileSize(env.size)} · Encrypted</small></span>
      <Download size={18} aria-hidden />
    </button>
  )
}

function Bubble({ m, mine, env, onRetry, onDelete }: { m: Msg; mine: boolean; env?: Plain; onRetry: () => void; onDelete: () => void }) {
  const url = useSigned(m.e2ee ? null : m.media_path)
  const local = m.preview
  const src = local ?? url
  const secure = Boolean(m.e2ee) && !m.deleted_at
  const onlyMedia = secure ? typeof env === 'object' && env.t === 'media' : !m.body && Boolean(m.media_path)
  return (
    <div className={`dm-msg${mine ? ' mine' : ''}`}>
      <div className={`dm-bubble${m.pending ? ' pending' : ''}${onlyMedia ? ' bare' : ''}${m.deleted_at ? ' deleted' : ''}`} onClick={() => (m.failed ? onRetry() : undefined)}>
        {secure ? (
          env === undefined ? <span className="dm-text dm-lock">🔒 Decrypting…</span>
            : env === 'locked' ? <span className="dm-text dm-lock">🔒 This message can’t be opened on this device.</span>
            : env.t === 'text' ? <span className="dm-text">{env.m}</span>
            : env.t === 'media' ? <SecureMedia m={m} env={env} />
            : env.t === 'voice' ? <SecureVoice m={m} env={env} />
            : <SecureFile m={m} env={env} />
        ) : <>
          {m.media_path && !m.deleted_at && (src ? (m.media_type === 'video' ? <video src={src} controls playsInline preload="metadata" /> : <img src={src} alt="Photo in this chat" loading="lazy" decoding="async" />) : <span className="skeleton" style={{ display: 'block', width: 200, height: 240 }} aria-hidden />)}
          {m.audio_path && m.audio_ms && !m.deleted_at && <VoiceNote path={m.audio_path} ms={m.audio_ms} />}
          {m.file_path && !m.deleted_at && <FileCard m={m} />}
          {m.body && <span className="dm-text">{m.body}</span>}
        </>}
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
  const bottom = useRef<HTMLDivElement>(null), camera = useRef<HTMLInputElement>(null), gallery = useRef<HTMLInputElement>(null), anyFile = useRef<HTMLInputElement>(null)
  const [cam, setCam] = useState(false), [attach, setAttach] = useState(false)
  const { start: startCall, inCall } = useCalls()
  const names = useAsync(async () => {
    const { data } = await supabase.from('conversation_members').select('profiles:user_id(id,username,display_name,avatar_path,verified_until)').eq('conversation_id', id).neq('user_id', uid!)
    return ((data ?? []) as unknown as { profiles: PublicProfile }[]).map(x => x.profiles)
  }, [id])
  const conv = useAsync(async () => { const { data } = await supabase.from('conversations').select('id,is_group,title').eq('id', id).maybeSingle(); return data as { id: string; is_group: boolean; title: string | null } | null }, [id])
  const other = !conv.data?.is_group ? names.data?.[0] : undefined
  const stats = useAsync<Stats | null>(() => (other ? profileStats(other.id) : Promise.resolve(null)), [other?.id])
  const keys = useChatKeys()
  const sc = useSecureChat({ conversationId: id, uid, peerId: other?.id, keys, group: Boolean(conv.data?.is_group), loading: conv.loading || names.loading })
  const [plain, setPlain] = useState<Record<string, Plain>>({})
  const [keySheet, setKeySheet] = useState(false), [codeSheet, setCodeSheet] = useState(false)

  const markRead = () => supabase.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', id).eq('user_id', uid!).then(() => { window.dispatchEvent(new Event('vybe:messages')) })

  // Merge by id (server rows win) and by client_id (replaces optimistic copies): delivery can repeat or arrive out of order.
  const merge = (incoming: Msg[]) => setMsgs(cur => {
    const byId = new Map<string, Msg>()
    for (const m of cur) if (!incoming.some(i => i.id === m.id || (i.client_id && i.client_id === m.client_id))) byId.set(m.id, m)
    for (const m of incoming) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  })

  const load = async () => {
    const r = await selectMessages(cols => supabase.from('messages').select(cols).eq('conversation_id', id).order('created_at', { ascending: false }).limit(60))
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

  // Decrypt encrypted messages as they arrive (and once keys become available).
  useEffect(() => {
    if (!sc.ready) return
    let live = true
    for (const m of msgs) {
      if (!m.e2ee || m.deleted_at || m.pending) continue
      sc.decrypt(m.body, m.sender).then(e => { if (live) setPlain(p => (p[m.id] ? p : { ...p, [m.id]: e })) })
    }
    return () => { live = false }
  }, [msgs, sc.ready, sc.decrypt]) // eslint-disable-line react-hooks/exhaustive-deps
  const settled = keys.state !== 'loading' && sc.peerPub !== undefined
  const envFor = (m: Msg): Plain | undefined => (m.e2ee ? plain[m.id] ?? (settled && !sc.ready && !m.pending ? 'locked' : undefined) : undefined)

  const deliver = async (draft: Partial<Msg> & { body: string }, clientId: string = crypto.randomUUID(), env?: Envelope) => {
    if (env) setPlain(p => ({ ...p, [clientId]: env }))
    const optimistic: Msg = { id: clientId, client_id: clientId, conversation_id: id, sender: uid!, created_at: new Date().toISOString(), deleted_at: null, pending: true, ...draft }
    setMsgs(c => [...c.filter(m => m.client_id !== clientId), optimistic])
    const row = {
      conversation_id: id, sender: uid, body: draft.body, client_id: clientId,
      ...(draft.media_path ? { media_path: draft.media_path, media_type: draft.media_type } : {}), ...(draft.audio_path ? { audio_path: draft.audio_path, audio_ms: draft.audio_ms } : {}),
      ...(draft.file_path ? { file_path: draft.file_path, file_name: draft.file_name, file_size: draft.file_size, file_mime: draft.file_mime } : {}), ...(draft.e2ee ? { e2ee: true } : {}),
    }
    const { data, error } = await supabase.from('messages').insert(row).select(draft.file_path || draft.e2ee ? FILE_COLS : MEDIA_COLS).single()
    if (error) {
      if (error.code === '23505') { load(); return } // duplicate client_id: it was already delivered
      setMsgs(c => c.map(m => (m.client_id === clientId ? { ...m, pending: false, failed: true } : m)))
      return toast(error.message.includes('rate limit') ? 'Slow down a little.' : 'Message failed to send')
    }
    const saved = data as unknown as Msg
    if (env) setPlain(p => ({ ...p, [saved.id]: env }))
    playSound('send'); merge([saved])
  }
  const needSecure = () => { if (sc.status === 'loading') { toast('One moment…'); return true } if (sc.status === 'needs-setup') { setKeySheet(true); return true } if (sc.blocked) { setCodeSheet(true); return true } return false }
  const addPending = (cid: string, extra: Partial<Msg>) => setMsgs(cur => [...cur, { id: cid, client_id: cid, conversation_id: id, sender: uid!, body: '', created_at: new Date().toISOString(), deleted_at: null, pending: true, ...extra }])
  const dropPending = (cid: string) => setMsgs(cur => cur.filter(m => m.id !== cid))

  const sendMedia = async (f?: File) => {
    if (!f || !uid || needSecure()) return
    const c = validateMedia(f); if (!c.ok) return toast(c.error)
    const cid = crypto.randomUUID(), local = URL.createObjectURL(f)
    if (sc.status === 'secure') {
      addPending(cid, { e2ee: true, preview: local, file_path: 'pending' })
      try {
        const up = await uploadEncrypted(uid, await f.arrayBuffer())
        const env: Envelope = { t: 'media', kind: c.type, mime: f.type, key: up.key, iv: up.iv, size: f.size }
        setPlain(p => ({ ...p, [cid]: { ...env, key: '' } }))                      // shows the local preview while it uploads
        await deliver({ body: await sc.encrypt(env), e2ee: true, file_path: up.path, file_name: 'Encrypted file', file_size: up.size, file_mime: 'application/octet-stream', preview: local }, cid, env)
      } catch (e) { dropPending(cid); toast(errMsg(e)) }
      return
    }
    addPending(cid, { media_type: c.type, preview: local })
    try { const up = await uploadMedia(uid, f); await deliver({ body: '', media_path: up.path, media_type: up.type }, cid) } catch (e) { dropPending(cid); toast(errMsg(e)) }
  }
  const sendDocument = async (f?: File) => {
    if (!f || !uid || needSecure()) return
    const bad = validateAttachment(f); if (bad) return toast(bad)
    const cid = crypto.randomUUID()
    if (sc.status === 'secure') {
      addPending(cid, { e2ee: true, file_path: 'pending' })
      setPlain(p => ({ ...p, [cid]: { t: 'file', name: f.name, mime: f.type, key: '', iv: '', size: f.size } }))
      try {
        const up = await uploadEncrypted(uid, await f.arrayBuffer())
        const env: Envelope = { t: 'file', name: f.name.slice(0, 200), mime: f.type || 'application/octet-stream', key: up.key, iv: up.iv, size: f.size }
        await deliver({ body: await sc.encrypt(env), e2ee: true, file_path: up.path, file_name: 'Encrypted file', file_size: up.size, file_mime: 'application/octet-stream' }, cid, env)
      } catch (e) { dropPending(cid); toast(errMsg(e)) }
      return
    }
    addPending(cid, { file_path: 'pending', file_name: f.name, file_size: f.size, file_mime: f.type })
    try { const up = await uploadAttachment(uid, f); await deliver({ body: '', file_path: up.path, file_name: up.name, file_size: up.size, file_mime: up.mime }, cid) } catch (e) { dropPending(cid); toast(errMsg(e)) }
  }
  /** The "+" picker: photos and videos go out as media, anything else as a file. */
  const sendAny = (f?: File) => { if (!f) return; void (validateMedia(f).ok ? sendMedia(f) : sendDocument(f)) }
  const sendVoice = async (a: { path: string; ms: number }) => { await deliver({ body: '', audio_path: a.path, audio_ms: a.ms }) }
  const sendVoiceSecure = async (clip: { blob: Blob; mime: string; ms: number }) => {
    if (!uid || needSecure()) throw new Error('Secure chat is not ready.')
    const up = await uploadEncrypted(uid, await clip.blob.arrayBuffer())
    const env: Envelope = { t: 'voice', mime: clip.mime, key: up.key, iv: up.iv, ms: clip.ms }
    await deliver({ body: await sc.encrypt(env), e2ee: true, file_path: up.path, file_name: 'Encrypted file', file_size: up.size, file_mime: 'application/octet-stream' }, crypto.randomUUID(), env)
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault(); const b = text.trim(); if (!b || needSecure()) return
    setText('')
    if (sc.status === 'secure') {
      try { const env: Envelope = { t: 'text', m: b }; await deliver({ body: await sc.encrypt(env), e2ee: true }, crypto.randomUUID(), env) } catch (err) { setText(b); toast(errMsg(err)) }
      return
    }
    void deliver({ body: b })
  }
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
          ? <Link to={`/app/u/${other.username}`} className="dm-who"><Avatar size="sm" path={other.avatar_path} uid={other.id} name={title} /><span className="dm-who-t"><b>{title}<VerifiedBadge profile={other} /></b><span>@{other.username}</span></span><ChevronRight size={16} aria-hidden /></Link>
          : <div className="dm-who"><Avatar size="sm" path={names.data?.[0]?.avatar_path} uid={names.data?.[0]?.id} name={title} /><span className="dm-who-t"><b>{title}</b><span>{(names.data?.length ?? 0) + 1} people</span></span></div>}
        {other && (
          <span className="dm-calls">
            <button className="icon-btn" aria-label={`Voice call ${title}`} disabled={inCall} onClick={() => void startCall(id, 'audio')}><Phone size={22} /></button>
            <button className="icon-btn" aria-label={`Video call ${title}`} disabled={inCall} onClick={() => void startCall(id, 'video')}><Video size={24} /></button>
          </span>
        )}
      </header>
      {other && sc.status !== 'standard' && sc.status !== 'loading' && sc.status !== 'needs-setup' && (
        <button type="button" className={`dm-secure${sc.status === 'peer-missing' ? ' off' : ''}${sc.change === 'changed' ? ' warn' : ''}`} onClick={() => setCodeSheet(true)}>
          {sc.change === 'changed' ? <><ShieldAlert size={14} aria-hidden /> {title}’s security code changed · Review</>
            : sc.status === 'secure' ? <><Lock size={14} aria-hidden /> End-to-end encrypted · Verify security code</>
            : <><Lock size={14} aria-hidden /> Not end-to-end encrypted yet — {title} hasn’t turned on secure chat</>}
        </button>
      )}
      {!online && <p className="notice err" role="status" style={{ margin: 8 }}>You're offline. Messages will send when you reconnect — tap a failed message to retry.</p>}
      <div className="dm-scroll" aria-live="polite">
        {other && (
          <div className="dm-intro">
            <Link to={`/app/u/${other.username}`} aria-label={`${title} profile`}><Avatar size="lg" path={other.avatar_path} uid={other.id} name={title} /></Link>
            <h1 className="dm-intro-name">{title}<VerifiedBadge profile={other} size={18} /></h1>
            <span className="dm-intro-handle">@{other.username}</span>
            <span className="dm-intro-stats">{stats.data?.followers != null ? `${compactNumber(stats.data.followers)} followers · ` : ''}{stats.data?.posts != null ? `${compactNumber(stats.data.posts)} posts` : ''}</span>
            {stats.data?.follows_me && <span className="dm-intro-stats">Follows you</span>}
          </div>
        )}
        {state === 'loading' ? <Spinner /> : state === 'error' ? <ErrorState message={error} onRetry={load} /> : msgs.length === 0 ? <p className="t-support" style={{ textAlign: 'center' }}>Say hello 👋</p> : msgs.map(m => (
          <Bubble key={m.id} m={m} mine={m.sender === uid} env={envFor(m)} onRetry={() => void deliver({ body: m.body, media_path: m.media_path, media_type: m.media_type, audio_path: m.audio_path, audio_ms: m.audio_ms, file_path: m.file_path, file_name: m.file_name, file_size: m.file_size, file_mime: m.file_mime, e2ee: m.e2ee }, m.client_id ?? undefined, (() => { const pe = plain[m.id]; return pe && pe !== 'locked' ? pe : undefined })())} onDelete={() => void remove(m)} />
        ))}
        <div ref={bottom} />
      </div>
      {sc.status === 'needs-setup' && (
        <div className="dm-banner" role="region" aria-label="Secure chat">
          <p><b>Turn on secure chat</b> to message {title}. Your messages, photos, videos, files and voice notes will be locked so only the two of you can read them.</p>
          <button className="btn primary" onClick={() => setKeySheet(true)}><Lock size={16} aria-hidden /> {keys.state === 'restore' ? 'Unlock' : 'Turn on'}</button>
        </div>
      )}
      {sc.blocked && (
        <div className="dm-banner" role="region" aria-label="Security code changed">
          <p><b>{title}’s security code changed.</b> This can happen when they get a new phone or reinstall. Check the new code with them before you keep sending private messages.</p>
          <span className="row" style={{ gap: 8 }}><button className="btn" onClick={() => setCodeSheet(true)}>Check code</button><button className="btn primary" onClick={() => void sc.accept()}>Continue</button></span>
        </div>
      )}
      <form onSubmit={submit} className="dm-bar" style={sc.status === 'needs-setup' || sc.blocked ? { display: 'none' } : undefined}>
        <button type="button" className="dm-cam" aria-label="Open the camera" onClick={() => setCam(true)}><Camera size={22} /></button>
        <input className="dm-input" aria-label="Message" placeholder="Message…" value={text} onChange={e => setText(e.target.value)} maxLength={4000} autoComplete="off" />
        {text.trim()
          ? <button className="dm-send" aria-label="Send message"><Send size={20} /></button>
          : <span className="dm-tools">
              <VoiceRecorder uid={uid!} onSend={sendVoice} onBlob={sc.status === 'secure' ? sendVoiceSecure : undefined} />
              <button type="button" className="icon-btn" aria-label="Photos and videos from your gallery" onClick={() => gallery.current?.click()}><ImageIcon size={24} /></button>
              <button type="button" className="icon-btn" aria-label="Attach a file" aria-haspopup="dialog" onClick={() => setAttach(true)}><Plus size={26} /></button>
            </span>}
      </form>
      {keySheet && <ChatKeySheet keys={keys} onClose={() => setKeySheet(false)} />}
      {codeSheet && (
        <Sheet title="Security code" onClose={() => setCodeSheet(false)}>
          <div className="stack" style={{ gap: 12 }}>
            {sc.code ? <>
              <p className="t-support">Compare this code with {title} — in person or on a call you trust. If it matches on both phones, nobody can be listening in between you.</p>
              <p className="e2-code" aria-label="Security code">{sc.code}</p>
            </> : <p className="t-support">{title} hasn’t turned on secure chat yet, so there is no code to compare. Until they do, messages are protected on their way to our servers but are not end-to-end encrypted.</p>}
            <p className="t-meta">Encrypted: message text, photos, videos, files and voice notes. Not hidden: who you talk to, when, and the size of attachments.</p>
            {sc.change === 'changed' && <button className="btn primary" onClick={() => { void sc.accept(); setCodeSheet(false) }}>I checked it — continue</button>}
            <button className="btn ghost" onClick={() => setCodeSheet(false)}>Close</button>
          </div>
        </Sheet>
      )}
      {cam && <CameraCapture onClose={() => setCam(false)} onCapture={f => { setCam(false); void sendMedia(f) }} onUnavailable={() => { setCam(false); camera.current?.click() }} />}
      {attach && (
        <Sheet title="Attach" onClose={() => setAttach(false)}>
          <div className="dm-attach">
            <button type="button" onClick={() => { setAttach(false); gallery.current?.click() }}><span className="dm-attach-ico a1"><ImageIcon size={22} /></span><span><b>Photos and videos</b><small>From your gallery</small></span></button>
            <button type="button" onClick={() => { setAttach(false); setCam(true) }}><span className="dm-attach-ico a2"><Camera size={22} /></span><span><b>Camera</b><small>Take a photo or record a video</small></span></button>
            <button type="button" onClick={() => { setAttach(false); anyFile.current?.click() }}><span className="dm-attach-ico a3"><Paperclip size={22} /></span><span><b>Document or any file</b><small>PDF, Word, Excel, audio, zip and more — up to {fileSize(MAX_FILE_BYTES)}</small></span></button>
          </div>
        </Sheet>
      )}
      <input ref={camera} type="file" hidden accept="image/*,video/*" capture="environment" onChange={e => { sendAny(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={gallery} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" onChange={e => { void sendMedia(e.target.files?.[0]); e.target.value = '' }} />
      <input ref={anyFile} type="file" hidden onChange={e => { sendAny(e.target.files?.[0]); e.target.value = '' }} />
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
