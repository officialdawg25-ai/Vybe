import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Eye, Globe, MessageCircle, MoreHorizontal, Music2, Plus, Send, Star, Users, Volume2, VolumeX, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { VoiceNote, VoiceRecorder } from '../components/VoiceNote'
import { NameTick } from '../components/VerifiedBadge'
import { MEMORY_BG, REACTIONS, authorMemories, loadRail, markSeen, replyToMemory, setReaction, type Memory, type ReactionKey } from '../lib/social'
import { timeAgo } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { playSound } from '../lib/sounds'
import { Avatar, Empty, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import type { PublicProfile } from '../lib/types'
import { CLIP_MS, cleanOverlays, filterCss, songUrl, useSongPlayer } from '../lib/studio'
import { OverlayLayer } from '../components/studio/Overlays'
import { Burst, Emoji } from '../components/Emoji'
import { Marquee } from '../components/Marquee'

const STILL_MS = 5500

/**
 * Full-screen memory viewer: progress bars, tap right/left to move, hold to pause, swipe left/right for the next person, swipe down to close.
 * Visitors reply with text or a voice note (sent privately to the owner) and react; owners see views, reactions and replies.
 */
export default function MemoryViewer() {
  const { authorId } = useParams()
  const [params] = useSearchParams()
  const highlights = params.get('h') === '1'
  const nav = useNavigate()
  const loc = useLocation()
  const { uid } = useAuth()
  const mine = authorId === uid
  const list = useAsync(() => authorMemories(authorId!, highlights), [authorId, highlights])
  const author = useAsync(async () => {
    const { data } = await supabase.from('profiles').select('id,username,display_name,avatar_path,verified_until').eq('id', authorId!).maybeSingle()
    return (data ?? null) as PublicProfile | null
  }, [authorId])
  const order = useAsync(async () => { try { return (await loadRail())?.map(r => r.author.id) ?? [] } catch { return [] as string[] } }, [])
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState(false)
  const [menu, setMenu] = useState(false)
  const [local, setLocal] = useState<Record<string, ReactionKey | null>>({})
  const [more, setMore] = useState(false)
  const [burst, setBurst] = useState<{ k: ReactionKey; n: number }>({ k: 'heart', n: 0 })
  const items = list.data ?? []
  const cur: Memory | undefined = items[Math.min(i, Math.max(items.length - 1, 0))]
  const down = useRef<{ x: number; y: number; t: number } | null>(null)
  // Where to land when there is no history to return to (a pasted link). Normally closing simply goes back.
  const closeTo = highlights || mine ? `/app/u/${author.data?.username ?? ''}` : '/app'

  const start = params.get('m')
  useEffect(() => { setI(0); setText(''); setMore(false) }, [authorId])
  useEffect(() => { if (items.length) { const at = start ? items.findIndex(m => m.id === start) : items.findIndex(m => !m.seen); setI(at >= 0 ? at : 0) } }, [list.data]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cur && !mine && uid) markSeen(cur.id, uid) }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const nextAuthor = useMemo(() => {
    if (mine || highlights) return null
    const idx = (order.data ?? []).indexOf(authorId!)
    return idx >= 0 ? (order.data ?? [])[idx + 1] ?? null : null
  }, [order.data, authorId, mine, highlights])
  const prevAuthor = useMemo(() => {
    if (mine || highlights) return null
    const idx = (order.data ?? []).indexOf(authorId!)
    return idx > 0 ? (order.data ?? [])[idx - 1] : null
  }, [order.data, authorId, mine, highlights])
  // Closing returns to the screen the viewer was opened from (Home rail, a profile, a notification). It never jumps to the
  // author's profile on its own: `location.key` is 'default' only when this was the first entry in the tab.
  const close = useCallback(() => { if (loc.key !== 'default') nav(-1); else nav(closeTo === '/app/u/' ? '/app' : closeTo, { replace: true }) }, [nav, closeTo, loc.key])
  const next = useCallback(() => {
    if (i + 1 < items.length) setI(i + 1)
    else if (nextAuthor) nav(`/app/memories/${nextAuthor}`, { replace: true })
    else close()
  }, [i, items.length, nextAuthor, nav, close])
  const prev = useCallback(() => { if (i > 0) setI(i - 1); else if (prevAuthor) nav(`/app/memories/${prevAuthor}`, { replace: true }) }, [i, prevAuthor, nav])

  // Photos and text advance on a timer (the length of the song clip when there is one); videos advance when they end.
  const holding = paused || detail || menu || more
  const hasSong = Boolean(cur?.music_title && (cur.music_preview_path || cur.music_path))
  const stillMs = hasSong ? CLIP_MS : STILL_MS
  // Remaining-time timer: a hold or release keeps the time already watched, so the bar and the advance never drift apart.
  const left = useRef(stillMs)
  useEffect(() => { left.current = stillMs }, [cur?.id, stillMs])
  useEffect(() => {
    if (!cur || cur.kind === 'video' || holding) return
    const t0 = Date.now(), t = setTimeout(next, Math.max(left.current, 0))
    return () => { clearTimeout(t); left.current -= Date.now() - t0 }
  }, [cur?.id, holding, next, stillMs]) // eslint-disable-line react-hooks/exhaustive-deps
  // The memory's song, from the moment its author chose. One sound switch for the whole viewer.
  const [muted, setMuted] = useState(false)
  const [songSrc, setSongSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true; setSongSrc(null)
    if (cur && hasSong) void songUrl({ preview_path: cur.music_preview_path, music_path: cur.music_path }).then(u => live && setSongSrc(u))
    return () => { live = false }
  }, [cur?.id, hasSong]) // eslint-disable-line react-hooks/exhaustive-deps
  // A video memory plays its song for exactly as long as the video runs (photos and text: the clip length, above).
  const [vidMs, setVidMs] = useState<number | null>(null)
  useEffect(() => setVidMs(null), [cur?.id])
  const song = useSongPlayer(songSrc, { playing: hasSong && !holding, start_ms: cur?.music_start_ms ?? 0, clip_ms: cur?.kind === 'video' && vidMs ? vidMs : CLIP_MS, muted })
  const overlays = useMemo(() => cleanOverlays(cur?.overlays), [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev() }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  }, [close, next, prev])

  const url = useSigned(cur?.media_path)
  const my = cur ? (cur.id in local ? local[cur.id] : cur.mine_reaction) : null
  const react = async (k: ReactionKey) => {
    if (!cur || !uid) return
    const had = my, nextK = had === k ? null : k
    setLocal(l => ({ ...l, [cur.id]: nextK })); setMore(false)
    if (nextK) setBurst(b => ({ k: nextK, n: b.n + 1 }))
    try { await setReaction(cur.id, uid, nextK, had); if (nextK) playSound('like') } catch (e) { setLocal(l => ({ ...l, [cur.id]: had })); toast(errMsg(e)) }
  }
  const sendText = async () => {
    if (!cur || !uid || !text.trim() || busy) return
    setBusy(true)
    try { await replyToMemory(cur.id, uid, { body: text }); setText(''); playSound('send'); toast('Reply sent') } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }
  const sendVoice = async (a: { path: string; ms: number }) => { if (!cur || !uid) return; await replyToMemory(cur.id, uid, { audio: a }); playSound('send'); toast('Voice reply sent') }
  const del = async () => {
    if (!cur || !confirm('Delete this memory?')) return
    const { error } = await supabase.from('memories').delete().eq('id', cur.id)
    if (error) return toast(errMsg(error))
    if (cur.media_path) await supabase.storage.from('media').remove([cur.media_path])
    setMenu(false); list.reload(); if (items.length === 1) close()
  }
  const toggleHighlight = async () => {
    if (!cur) return
    const title = cur.highlight ? null : (prompt('Name this highlight (optional)', cur.highlight_title ?? '') ?? '').slice(0, 40) || null
    const { error } = await supabase.from('memories').update({ highlight: !cur.highlight, highlight_title: title }).eq('id', cur.id)
    if (error) return toast(errMsg(error))
    toast(cur.highlight ? 'Removed from highlights' : 'Added to your highlights'); setMenu(false); list.reload()
  }

  // Press anywhere to hold. Window-level listeners guarantee the release is seen even if the finger slides off the element,
  // and a press never reaches `next()` unless it was a quick tap on the picture itself.
  const swallow = useRef(false)
  const onDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, [data-typing]')) return                    // typing or recording a reply is not a press
    const onStage = Boolean(t.closest('.mvw-stage')) && !t.closest('a, button')
    down.current = { x: e.clientX, y: e.clientY, t: Date.now() }
    setPaused(true); song.unblock()                                            // inside the gesture: lets the browser start the sound
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const done = (u: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel)
      setPaused(false)
      const d = down.current; down.current = null
      if (!d || cancelled) return
      const dx = u.clientX - d.x, dy = u.clientY - d.y, held = Date.now() - d.t, moved = Math.hypot(dx, dy)
      if (held > 350 || moved > 12) { swallow.current = true; setTimeout(() => { swallow.current = false }, 60) }   // a hold or drag must not also "click"
      if (dy > 90 && Math.abs(dy) > Math.abs(dx)) return close()
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) { nextAuthor ? nav(`/app/memories/${nextAuthor}`, { replace: true }) : next() } else { prevAuthor ? nav(`/app/memories/${prevAuthor}`, { replace: true }) : prev() } return }
      if (!onStage || held > 280 || moved > 12) return                         // only a quick tap on the picture moves on
      if (u.clientX - rect.left < rect.width * 0.3) prev(); else next()
    }
    const up = (u: PointerEvent) => done(u, false), cancel = (u: PointerEvent) => done(u, true)
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel)
  }

  if (list.loading && !list.data) return <div className="mvw"><h1 className="sr-only">Memories</h1><div className="mvw-center"><Spinner /></div></div>
  if (list.error || !cur) return (
    <div className="mvw"><h1 className="sr-only">Memories</h1><button className="mvw-x" aria-label="Close" onClick={close}><X size={26} /></button>
      <div className="mvw-center"><Empty title="Nothing to watch">{list.error ?? 'This memory has expired or isn’t available to you.'}</Empty></div></div>
  )
  const a = author.data
  return (
    <div className="mvw" role="dialog" aria-modal="true" aria-label={`Memories from ${a?.display_name || a?.username || 'a member'}`} onPointerDown={onDown} onClickCapture={e => { if (swallow.current) { e.preventDefault(); e.stopPropagation() } }} onContextMenu={e => e.preventDefault()}>
      <h1 className="sr-only">Memories from {a?.display_name || a?.username || 'a member'}</h1>
      <div className="mvw-top">
        <div className="mvw-bars" role="progressbar" aria-valuemin={1} aria-valuemax={items.length} aria-valuenow={i + 1} aria-label={`Memory ${i + 1} of ${items.length}`}>
          {items.map((m, k) => <span key={m.id} className="mvw-bar"><i className={k < i ? 'done' : k === i ? 'run' : ''} style={k === i && m.kind !== 'video' ? { animationDuration: `${m.music_title && (m.music_preview_path || m.music_path) ? CLIP_MS : STILL_MS}ms`, animationPlayState: holding ? 'paused' : 'running' } : undefined} /></span>)}
        </div>
        <div className="mvw-who">
          {a && <Link to={`/app/u/${a.username}`} className="mvw-id"><Avatar size="sm" path={a.avatar_path} name={a.display_name || a.username} /><b><NameTick name={a.display_name || a.username} profile={a} size={14} /></b></Link>}
          <span className="mvw-time">{timeAgo(cur.created_at)} · {cur.visibility === 'public' ? <Globe size={12} aria-label="Public" /> : cur.visibility === 'close_friends' ? <span className="cf-badge xs" role="img" aria-label="Close Friends"><Star size={9} fill="currentColor" /></span> : <Users size={12} aria-label="Friends" />}</span>
          <span className="grow" />
          {(hasSong || cur.kind === 'video') && <button className="mvw-btn" aria-label={muted ? 'Sound on' : 'Sound off'} aria-pressed={!muted} onClick={() => { setMuted(m => !m); song.unblock() }}>{muted ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>}
          {mine && <button className="mvw-btn" aria-label="More options" onClick={() => setMenu(true)}><MoreHorizontal size={22} /></button>}
          <button className="mvw-btn" aria-label="Close" onClick={close}><X size={24} /></button>
        </div>
        {cur.music_title && <p className="mvw-song"><Music2 size={13} aria-hidden /> <Marquee>{`${cur.music_title}${cur.music_artist ? ` · ${cur.music_artist}` : ''}`}</Marquee>{song.blocked && !muted && <button className="mvw-tapsound" onClick={song.unblock}>Tap for sound</button>}</p>}
      </div>

      <div className="mvw-stage">
        {cur.kind === 'text' ? <div className="mvw-text" style={{ background: MEMORY_BG[cur.bg] ?? MEMORY_BG.violet }}><p>{cur.text_body}</p></div>
          : !url ? <div className="mvw-center"><Spinner /></div>
          : cur.kind === 'video' ? <video key={cur.id} src={url} autoPlay playsInline controls={false} muted={hasSong || muted} onEnded={next} onLoadedMetadata={e => { const d = e.currentTarget.duration; if (Number.isFinite(d)) setVidMs(Math.round(d * 1000)) }} style={{ filter: filterCss(cur.filter) }} ref={v => { if (v) { if (holding) v.pause(); else void v.play().catch(() => { v.muted = true; void v.play().catch(() => {}) }) } }} />
          : <img key={cur.id} src={url} alt={cur.text_body || 'Memory'} draggable={false} style={{ filter: filterCss(cur.filter) }} />}
        {overlays.length > 0 && <OverlayLayer items={overlays} />}
        {cur.kind !== 'text' && cur.text_body && <p className="mvw-caption">{cur.text_body}</p>}
      </div>

      <div className="mvw-bottom">
        {mine ? (
          <button className="mvw-stats" onClick={() => setDetail(true)} aria-label="See who viewed, reacted and replied">
            <span><Eye size={18} aria-hidden /> {cur.views ?? 0}</span><span><Emoji k="heart" size="1.1rem" /> {cur.reactions ?? 0}</span><span><MessageCircle size={18} aria-hidden /> {cur.replies ?? 0}</span>
            <span className="grow" /><span className="mvw-more">Activity ›</span>
          </button>
        ) : (
          <div className="mvw-reply" data-typing>
            <input className="mvw-input" aria-label="Send a reply" placeholder="Send message…" value={text} maxLength={500} onChange={e => setText(e.target.value)}
              onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} onKeyDown={e => { if (e.key === 'Enter') void sendText() }} />
            {text.trim() ? <button className="mvw-send" aria-label="Send reply" disabled={busy} onClick={sendText}><Send size={20} /></button>
              : <div className="mvw-voice"><VoiceRecorder uid={uid!} onSend={sendVoice} disabled={busy} /></div>}
            <div className="mvw-react" role="group" aria-label="React" style={{ position: 'relative' }}>
              {REACTIONS.slice(0, more ? 6 : 2).map(r => <button key={r.key} className={`mvw-emo${my === r.key ? ' on' : ''}`} aria-pressed={my === r.key} aria-label={r.label} onClick={() => react(r.key)}><Emoji k={r.key} idle={my === r.key} /></button>)}
              <Burst k={burst.k} n={burst.n} />
              {!more && <button className="mvw-emo plus" aria-label="More reactions" onClick={() => setMore(true)}><Plus size={18} /></button>}
            </div>
          </div>
        )}
      </div>

      {menu && mine && (
        <Sheet title="Memory options" onClose={() => setMenu(false)}>
          <div className="stack" style={{ gap: 8 }}>
            <Link className="btn primary" to="/app/memories/new" onClick={() => setMenu(false)}>Add another memory</Link>
            <button className="btn" onClick={toggleHighlight}>{cur.highlight ? 'Remove from highlights' : 'Add to highlights'}</button>
            <button className="btn danger" onClick={del}>Delete memory</button>
            <button className="btn ghost" onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
      {detail && mine && <ActivitySheet memory={cur} onClose={() => setDetail(false)} />}
    </div>
  )
}

type ActTab = 'replies' | 'reactions' | 'seen'
function ActivitySheet({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  const [tab, setTab] = useState<ActTab>('replies')
  const data = useAsync(async () => {
    const sel = 'profiles:viewer(id,username,display_name,avatar_path)'
    const [v, r, p] = await Promise.all([
      supabase.from('memory_views').select(`viewer,viewed_at,${sel}`).eq('memory_id', memory.id).order('viewed_at', { ascending: false }).limit(200),
      supabase.from('memory_reactions').select('user_id,emoji,created_at,profiles:user_id(id,username,display_name,avatar_path)').eq('memory_id', memory.id).order('created_at', { ascending: false }).limit(200),
      supabase.from('memory_replies').select('id,body,audio_path,audio_ms,created_at,profiles:author(id,username,display_name,avatar_path)').eq('memory_id', memory.id).order('created_at', { ascending: false }).limit(100),
    ])
    for (const x of [v, r, p]) if (x.error) throw x.error
    return {
      views: (v.data ?? []) as unknown as { viewer: string; viewed_at: string; profiles: PublicProfile }[],
      reactions: (r.data ?? []) as unknown as { user_id: string; emoji: ReactionKey; created_at: string; profiles: PublicProfile }[],
      replies: (p.data ?? []) as unknown as { id: string; body: string; audio_path: string | null; audio_ms: number | null; created_at: string; profiles: PublicProfile }[],
    }
  }, [memory.id])
  const d = data.data
  const tabs: { id: ActTab; label: string; n: number }[] = [
    { id: 'replies', label: 'Replies', n: d?.replies.length ?? 0 },
    { id: 'reactions', label: 'Reactions', n: d?.reactions.length ?? 0 },
    { id: 'seen', label: 'Seen by', n: d?.views.length ?? 0 },
  ]
  const who = (p?: PublicProfile) => p?.display_name || p?.username || 'Someone'
  return (
    <Sheet title="Memory activity" onClose={onClose}>
      {data.loading ? <Spinner /> : data.error || !d ? <p className="error" role="alert">{data.error}</p> : (
        <>
          <div className="act-tabs" role="tablist" aria-label="Memory activity">
            {tabs.map(t => (
              <button key={t.id} role="tab" id={`act-${t.id}`} aria-selected={tab === t.id} aria-controls="act-panel" className="act-tab" onClick={() => setTab(t.id)}>
                {t.label}<b>{t.n}</b>
              </button>
            ))}
          </div>
          <div className="act-list" id="act-panel" role="tabpanel" aria-labelledby={`act-${tab}`}>
            {tab === 'replies' && (d.replies.length === 0 ? <p className="act-empty">No replies yet.</p> : d.replies.map(r => (
              <div key={r.id} className="act-row top">
                <Avatar size="sm" path={r.profiles?.avatar_path} name={who(r.profiles)} />
                <div className="grow">
                  <div className="act-name">{who(r.profiles)}<span>{timeAgo(r.created_at)}</span></div>
                  {r.body && <p className="act-bubble">{r.body}</p>}
                  {r.audio_path && r.audio_ms && <VoiceNote path={r.audio_path} ms={r.audio_ms} />}
                </div>
              </div>)))}
            {tab === 'reactions' && (d.reactions.length === 0 ? <p className="act-empty">No reactions yet.</p> : d.reactions.map(r => (
              <div key={r.user_id} className="act-row">
                <Avatar size="sm" path={r.profiles?.avatar_path} name={who(r.profiles)} />
                <div className="grow"><div className="act-name">{who(r.profiles)}<span>{timeAgo(r.created_at)}</span></div></div>
                <Emoji k={r.emoji} size="1.6rem" idle />
              </div>)))}
            {tab === 'seen' && (d.views.length === 0 ? <p className="act-empty">No views yet.</p> : d.views.map(v => (
              <div key={v.viewer} className="act-row">
                <Avatar size="sm" path={v.profiles?.avatar_path} name={who(v.profiles)} />
                <div className="grow"><div className="act-name">{who(v.profiles)}<span>{timeAgo(v.viewed_at)}</span></div></div>
              </div>)))}
          </div>
        </>
      )}
    </Sheet>
  )
}
