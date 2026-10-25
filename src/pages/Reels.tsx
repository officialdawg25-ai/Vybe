import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Bookmark, Camera, Heart, MessageCircle, Music2, Send, Volume2, VolumeX, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import { cursorOf, fetchPosts, sharePost } from '../lib/posts'
import { useChromeless } from '../lib/chrome'
import { playSound } from '../lib/sounds'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../ui'
import { Comments } from '../components/Comments'
import { VerifiedBadge } from '../components/VerifiedBadge'
import type { Post } from '../lib/types'
import { usePolicy } from '../lib/dataMode'
import { record } from '../lib/metrics'

const count = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/**
 * Reels: full-height vertical videos, one per screen. Swipe (or scroll, or use the arrow keys) to move; the one on screen
 * plays and the rest pause. Sound is one switch for every reel. Likes, comments (text, voice or video notes), sharing and
 * saving are the same records as posts, so counts and privacy follow the post rules.
 */
export default function Reels() {
  const { uid } = useAuth()
  const nav = useNavigate()
  useChromeless()
  useEffect(() => { document.title = 'Reels · VYBE' }, [])
  const [items, setItems] = useState<Post[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [more, setMore] = useState(true)
  const [muted, setMuted] = useState(true)
  const [active, setActive] = useState(0)
  const [comments, setComments] = useState<Post | null>(null)
  const loading = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const policy = usePolicy()
  const [playingId, setPlayingId] = useState<string | null>(null)        // the reel that has actually started
  // Opened from a suggested reel on Home: that reel plays first, then the usual list follows.
  const [params] = useSearchParams()
  const start = params.get('start')

  const load = useCallback(async (cursor?: string) => {
    if (loading.current) return
    loading.current = true
    try {
      const [rows, first] = await Promise.all([fetchPosts({ uid: uid!, reels: true, cursor }), !cursor && start ? fetchPosts({ uid: uid!, reels: true, ids: [start] }).catch(() => []) : Promise.resolve([])])
      setItems(x => (cursor ? [...x, ...rows.filter(r => !x.some(y => y.id === r.id))] : [...first, ...rows.filter(r => !first.some(f => f.id === r.id))]))
      setMore(rows.length > 0); setState('ready')
    } catch (e) {
      // A failed next page keeps what is on screen (the reel being watched must not vanish); only a failed first load shows the error.
      if (cursor) { setMore(false); toast('Couldn’t load more reels. Pull back to the top to try again.') } else { setErr(errMsg(e)); setState('error') }
    } finally { loading.current = false }
  }, [uid, start])
  useEffect(() => { void load() }, [load])
  // Fetch the next page while two reels are still left.
  useEffect(() => { if (more && items.length && active >= items.length - 2) void load(cursorOf(items.at(-1)!)) }, [active, items, more, load])
  const onScroll = () => { const el = list.current; if (el) setActive(Math.round(el.scrollTop / el.clientHeight)) }
  const go = (d: number) => { const el = list.current; if (el) el.scrollTo({ top: (active + d) * el.clientHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
  const patch = (p: Post) => setItems(x => x.map(y => (y.id === p.id ? p : y)))

  return (
    <div className="reels" onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); go(1) } else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1) } }}>
      <header className="reels-top">
        <h1>Reels</h1>
        <Link to="/app/reels/new" className="reels-cam" aria-label="Create a reel"><Camera size={24} /></Link>
      </header>
      {state === 'loading' ? <div className="reels-msg"><Spinner /></div>
        : state === 'error' ? <div className="reels-msg"><ErrorState message={err} onRetry={() => { setState('loading'); void load() }} /></div>
        : !items.length ? <div className="reels-msg"><Empty title="No reels yet" action={<button className="btn primary" onClick={() => nav('/app/reels/new')}>Create the first reel</button>}>Short vertical videos from people and pages show up here.</Empty></div>
        : (
          <div ref={list} className="reels-list" onScroll={onScroll} tabIndex={0} aria-label="Reels: swipe up for the next one" role="feed" aria-busy={loading.current}>
            {/* Only the reel on screen holds a video element, plus the ones either side once it is playing (so on a slow link
                they never compete with it for bandwidth; skipped on constrained devices). The rest are posters, so scrolling
                far never piles up players or downloads. */}
            {items.map((p, i) => <Reel key={p.id} post={p} active={i === active} near={i === active || (policy.prefetchNextVideo && Math.abs(i - active) <= 1 && playingId === items[active]?.id)} onStarted={() => setPlayingId(p.id)} muted={muted} setMuted={setMuted} onChange={patch} onComments={() => setComments(p)} />)}
            {!more && <div className="reels-end">You’re all caught up.</div>}
          </div>
        )}
      {comments && (
        <div className="reels-sheet" role="dialog" aria-modal="true" aria-label="Comments">
          <div className="reels-sheet-head"><b>Comments</b><button className="icon-btn" aria-label="Close comments" onClick={() => setComments(null)}><X size={22} /></button></div>
          <div className="reels-sheet-body"><Comments postId={comments.id} postAuthor={comments.author} /></div>
        </div>
      )}
    </div>
  )
}

function Reel({ post, active, near, onStarted, muted, setMuted, onChange, onComments }: { post: Post; active: boolean; near: boolean; onStarted: () => void; muted: boolean; setMuted: (m: boolean) => void; onChange: (p: Post) => void; onComments: () => void }) {
  const { uid } = useAuth()
  const media = post.post_media?.[0]
  const src = useSigned(near ? media?.path ?? post.media_path : null)
  const poster = useSigned(media?.poster_path ?? null)
  const v = useRef<HTMLVideoElement>(null)
  const [paused, setPaused] = useState(false)
  const [burst, setBurst] = useState(0)
  const [pct, setPct] = useState(0)
  const lastTap = useRef(0)
  const liked = post.mine_reaction.length > 0, saved = post.mine_save.length > 0
  const likes = post.reactions[0]?.count ?? 0, comments = post.comments[0]?.count ?? 0
  const author = post.profiles

  useEffect(() => {
    const el = v.current; if (!el) return
    if (active && !paused) void el.play().catch(() => {}); else el.pause()
  }, [active, paused, src])
  // Start-up time (becoming the active reel → first frame playing) and stalls while it is on screen, measured per view.
  const startedAt = useRef<number | null>(null)
  const stallAt = useRef<number | null>(null)
  useEffect(() => { startedAt.current = active ? performance.now() : null }, [active])
  const onPlaying = () => {
    if (active) onStarted()
    if (startedAt.current != null) { record('reel_startup_ms', performance.now() - startedAt.current); startedAt.current = null }
    if (stallAt.current != null) { record('reel_stall_ms', performance.now() - stallAt.current); stallAt.current = null }
  }
  const onWaiting = () => { if (active && startedAt.current == null && stallAt.current == null) { stallAt.current = performance.now(); record('reel_stall', 1) } }
  useEffect(() => { if (!active) setPaused(false) }, [active])

  const setLike = async (want: boolean) => {
    if (want === liked) return
    const prev = post
    playSound(want ? 'like' : 'unlike')
    onChange({ ...post, mine_reaction: want ? [{ user_id: uid! }] : [], reactions: [{ count: Math.max(0, likes + (want ? 1 : -1)) }] })
    const { error } = want ? await supabase.from('reactions').insert({ post_id: post.id, user_id: uid }) : await supabase.from('reactions').delete().eq('post_id', post.id).eq('user_id', uid!)
    if (error && error.code !== '23505') { onChange(prev); toast(errMsg(error)) }
  }
  const toggleSave = async () => {
    const prev = post
    onChange({ ...post, mine_save: saved ? [] : [{ user_id: uid! }] })
    const { error } = saved ? await supabase.from('saves').delete().eq('post_id', post.id).eq('user_id', uid!) : await supabase.from('saves').insert({ post_id: post.id, user_id: uid })
    if (error && error.code !== '23505') { onChange(prev); toast(errMsg(error)) } else toast(saved ? 'Removed from saved' : 'Saved')
  }
  const share = async () => { const r = await sharePost(post.id, post.body.slice(0, 80) || 'A reel on VYBE'); if (r !== 'cancelled') playSound('share'); if (r === 'copied') toast('Link copied') }
  // Tap pauses or plays; a double tap likes.
  const tap = () => {
    const now = Date.now()
    if (now - lastTap.current < 300) { lastTap.current = 0; setBurst(b => b + 1); void setLike(true); return }
    lastTap.current = now
    setTimeout(() => { if (lastTap.current === now) setPaused(p => !p) }, 300)
  }

  return (
    <article className="reel" aria-label={`Reel by ${author.display_name || author.username}`}>
      <div className="reel-stage" onClick={tap}>
        {src ? <video ref={v} className="reel-video" src={src} poster={poster ?? undefined} muted={muted} loop playsInline preload={active ? 'auto' : 'metadata'} onPlaying={onPlaying} onWaiting={onWaiting}
          onTimeUpdate={e => { const el = e.currentTarget; if (el.duration) setPct((el.currentTime / el.duration) * 100) }} aria-label="Reel video" />
          : <div className="reel-video" style={poster ? { backgroundImage: `url(${poster})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined} aria-hidden />}
        {paused && <span className="reel-paused" aria-hidden>▶</span>}
        {burst > 0 && <span key={burst} className="reel-burst" aria-hidden>❤️</span>}
      </div>
      <div className="reel-shade" aria-hidden />
      <div className="reel-info">
        <Link to={`/app/u/${author.username}`} className="reel-author"><Avatar size="sm" path={author.avatar_path} uid={post.author} name={author.display_name || author.username} /><b>{author.display_name || author.username}</b><VerifiedBadge profile={author} size={14} /></Link>
        {post.body && <p className="reel-caption clamp-3">{post.body}</p>}
        {post.music_title && <p className="reel-music"><Music2 size={14} aria-hidden /> <span className="clamp-1">{post.music_title}{post.music_artist ? ` · ${post.music_artist}` : ''}</span></p>}
      </div>
      <div className="reel-actions">
        <button aria-label={liked ? 'Unlike' : 'Like'} aria-pressed={liked} className={liked ? 'on' : ''} onClick={() => void setLike(!liked)}><Heart size={30} fill={liked ? 'currentColor' : 'none'} /><span>{count(likes)}</span></button>
        <button aria-label={`Comments (${comments})`} onClick={onComments}><MessageCircle size={30} /><span>{count(comments)}</span></button>
        <button aria-label="Share" onClick={() => void share()}><Send size={28} /><span>Share</span></button>
        <button aria-label={saved ? 'Remove from saved' : 'Save'} aria-pressed={saved} className={saved ? 'on' : ''} onClick={() => void toggleSave()}><Bookmark size={28} fill={saved ? 'currentColor' : 'none'} /><span>{saved ? 'Saved' : 'Save'}</span></button>
        <button aria-label={muted ? 'Turn sound on' : 'Turn sound off'} aria-pressed={!muted} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={26} /> : <Volume2 size={26} />}</button>
      </div>
      <div className="reel-progress" aria-hidden><i style={{ width: `${pct}%` }} /></div>
    </article>
  )
}
