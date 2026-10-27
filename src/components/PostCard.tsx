import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bookmark, CalendarDays, ExternalLink, Globe, Heart, MapPin, MessageCircle, MoreHorizontal, Music2, Send, Users, UsersRound, Volume2, VolumeX } from 'lucide-react'
import type { Post } from '../lib/types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, Sheet, errMsg, toast } from '../ui'
import { formatEventTime } from '../lib/format'
import { sharePost } from '../lib/posts'
import { compactNumber, moodOf, moodText } from '../lib/social'
import { useFollowing } from '../lib/followStore'
import { playSound } from '../lib/sounds'
import { PostMedia } from './PostMedia'
import { ReportSheet } from './Report'
import { VerifiedBadge } from './VerifiedBadge'
import { useLiveProfiles } from '../lib/liveProfiles'
import { setFeedClock, useFeedSong } from '../lib/feedSound'
import { brandUrl } from '../lib/social'
import { signedUrl } from '../lib/media'

const VIS = {
  public: { icon: Globe, label: 'Public' },
  friends: { icon: Users, label: 'Friends' },
  community: { icon: UsersRound, label: 'Community' },
}
const dayLabel = (iso: string) => {
  const d = new Date(iso), now = new Date()
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(d)
}

/**
 * Instagram-style post card: header (avatar, name, tick, a small "Follow" after the name, song or place underneath, sound,
 * menu), edge-to-edge media at its original size, an actions row with counts, then the caption below the media. The name
 * always keeps its room: it shortens with "…" only when it truly does not fit, and nothing is drawn over it.
 * A post's song plays by itself while the post is on screen, once the feed's sound is on (lib/feedSound).
 */
export function PostCard({ post, onChange, onDeleted }: { post: Post; onChange: (p: Post) => void; onDeleted: (id: string) => void }) {
  const { uid } = useAuth()
  const live = useLiveProfiles()
  const author = live(post.profiles)
  const following = useFollowing(uid)
  const [menu, setMenu] = useState(false)
  const [report, setReport] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(post.body)
  const [more, setMore] = useState(false)
  // The song, from the moment its author chose (update 32; older posts start at the beginning).
  const songSrc = post.music_track_id && post.track?.preview_path ? post.track.preview_path : null
  const song = useMemo(() => (songSrc || post.music_path
    ? { src: async () => (songSrc ? brandUrl(songSrc) : signedUrl(post.music_path!)), start: (post.music_start_ms ?? 0) / 1000, clip: 30 }
    : null), [songSrc, post.music_path, post.music_start_ms])
  const sound = useFeedSong(post.id, song)
  const navigate = useNavigate()
  const onClock = useCallback((v: HTMLVideoElement | null) => setFeedClock(post.id, v), [post.id])
  // A video opens full screen in Reels at the moment it had reached; Back returns here.
  const openVideo = useCallback((_: number, t: number) => navigate(`/app/reels?start=${post.id}${t > 0.5 ? `&t=${t.toFixed(1)}` : ''}`), [navigate, post.id])
  const liked = post.mine_reaction.length > 0
  const saved = post.mine_save.length > 0
  const mine = post.author === uid
  const Vis = VIS[post.visibility]
  const mood = moodOf(post.feeling)
  const gallery = (post.post_media?.length ? [...post.post_media].sort((a, b) => a.sort - b.sort) : post.media_path && post.media_type ? [{ path: post.media_path, type: post.media_type }] : [])
  const tagged = post.tags ?? []
  const likes = post.reactions[0]?.count ?? 0, comments = post.comments[0]?.count ?? 0
  const name = post.org ? post.org.name : (author.display_name || author.username)
  const canFollow = !mine && !post.org && following.ready && !following.has(post.author)
  const hasText = Boolean(post.body.trim())
  const long = post.body.length > 140 || post.body.split('\n').length > 2
  const hasMeta = Boolean(mood || tagged.length || (post.place_name && post.music_title))

  // Optimistic toggles with rollback on failure.
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
    if (error && error.code !== '23505') { onChange(prev); toast(errMsg(error)) } else toast(saved ? 'Removed from saved' : 'Saved privately')
  }
  const share = async () => { const r = await sharePost(post.id, post.body.slice(0, 80)); if (r !== 'cancelled') playSound('share'); if (r === 'copied') toast('Link copied') }
  const follow = async () => { try { await following.toggle(post.author, true); toast(`Following ${author.display_name || author.username}`) } catch (e) { toast(errMsg(e)) } }
  const remove = async () => {
    setMenu(false)
    if (!confirm('Delete this post?')) return
    const { error } = await supabase.from('posts').delete().eq('id', post.id)
    if (error) return toast(errMsg(error))
    const paths = [...new Set([post.media_path, ...(post.post_media ?? []).flatMap(m => [m.path, m.poster_path, m.display_path])].filter((x): x is string => Boolean(x)))]
    if (paths.length) await supabase.storage.from('media').remove(paths)
    onDeleted(post.id)
  }
  const saveEdit = async () => {
    const body = draft.trim()
    if (!body && !post.media_path && !post.post_media?.length) return
    const { error } = await supabase.from('posts').update({ body }).eq('id', post.id)
    if (error) return toast(errMsg(error))
    onChange({ ...post, body, edited_at: new Date().toISOString() })
    setEditing(false)
  }

  return (
    <article className="igp" aria-label={`Post by ${name}`} ref={sound.ref}>
      <header className="igp-h">
        <Link to={`/app/u/${author.username}`} aria-label={`${author.display_name || author.username} profile`}><Avatar path={author.avatar_path} uid={author.id} name={author.display_name || author.username} /></Link>
        <div className="igp-who">
          <div className="igp-line">
            <Link to={`/app/u/${author.username}`} className="igp-name"><span className="igp-name-t">{name}</span>{!post.org && <VerifiedBadge profile={author} />}</Link>
            {canFollow && <><span className="igp-dot" aria-hidden>•</span><button className="igp-follow" onClick={follow} aria-label={`Follow ${author.display_name || author.username}`}>Follow</button></>}
          </div>
          {post.music_title
            ? <span className="igp-sub"><Music2 size={12} aria-hidden /> <span className="igp-sub-t">{post.music_artist ? `${post.music_artist} · ` : ''}{post.music_title}</span></span>
            : post.place_name ? <span className="igp-sub"><MapPin size={12} aria-hidden /> <span className="igp-sub-t">{post.place_name}</span></span>
            : post.org ? <span className="igp-sub"><span className="igp-sub-t">Page · @{author.username}</span></span> : null}
        </div>
        {song && (
          <button className={`igp-sound${sound.playing ? ' on' : ''}`} aria-pressed={!sound.muted && sound.active} onClick={sound.toggle}
            aria-label={sound.muted || !sound.active ? `Play ${post.music_title ?? 'the song'} with sound` : 'Turn sound off'}>
            {sound.muted || !sound.active ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        )}
        <button className="icon-btn igp-menu" aria-label="More options" aria-haspopup="dialog" onClick={() => setMenu(true)}><MoreHorizontal size={22} /></button>
      </header>

      {gallery.length > 0
        ? <PostMedia items={gallery} liked={liked} onDoubleTap={() => setLike(true)} silent={Boolean(song)} onClock={song ? onClock : undefined} onOpenVideo={openVideo} />
        : hasText && !editing && <div className="igp-text" onDoubleClick={() => setLike(true)}><p>{post.body}</p></div>}

      <div className="igp-actions">
        <button className="igp-act" aria-pressed={liked} aria-label={liked ? 'Remove like' : 'Like'} onClick={() => setLike(!liked)}><Heart size={26} className={liked ? 'liked' : ''} fill={liked ? 'currentColor' : 'none'} />{likes > 0 && <span>{compactNumber(likes)}</span>}</button>
        <Link className="igp-act" aria-label={`Comments, ${comments}`} to={`/app/posts/${post.id}`}><MessageCircle size={26} />{comments > 0 && <span>{compactNumber(comments)}</span>}</Link>
        <button className="igp-act" aria-label="Share" onClick={share}><Send size={25} /></button>
        <span className="grow" />
        <button className="igp-act" aria-pressed={saved} aria-label={saved ? 'Unsave' : 'Save'} onClick={toggleSave}><Bookmark size={26} fill={saved ? 'currentColor' : 'none'} /></button>
      </div>

      <div className="igp-body">
        {editing ? (
          <div className="stack" style={{ gap: 8 }}>
            <textarea className="textarea" aria-label="Edit post" value={draft} onChange={e => setDraft(e.target.value)} maxLength={5000} />
            <div className="row"><button className="btn sm primary" onClick={saveEdit}>Save</button><button className="btn sm" onClick={() => { setEditing(false); setDraft(post.body) }}>Cancel</button></div>
          </div>
        ) : hasText && gallery.length > 0 && (
          <p className={`igp-caption${more ? '' : ' clamp'}`}><Link to={`/app/u/${author.username}`} className="igp-cap-name">{name}</Link> {post.body}{long && !more && <button className="igp-more" onClick={() => setMore(true)}>… more</button>}</p>
        )}
        {hasMeta && (
          <p className="post-with">
            {mood && <span>{mood.emoji} {moodText(mood)}</span>}
            {post.place_name && post.music_title && <span><MapPin size={13} aria-hidden /> {post.place_name}</span>}
            {tagged.length > 0 && <span>with {tagged.slice(0, 2).map((t, i) => <span key={t.profiles.id}>{i > 0 && ', '}<Link to={`/app/u/${t.profiles.username}`}>{live(t.profiles).display_name || t.profiles.username}</Link></span>)}{tagged.length > 2 ? ` and ${tagged.length - 2} ${tagged.length === 3 ? 'other' : 'others'}` : ''}</span>}
          </p>
        )}
        {post.event && post.event.status === 'active' && (
          <Link to={`/app/plans/${post.event.id}`} className="shared-plan">
            <CalendarDays size={20} aria-hidden /><span className="grow"><span className="t-name clamp-1" style={{ display: 'block' }}>{post.event.title}</span>
              <span className="t-meta clamp-1" style={{ display: 'block' }}>{formatEventTime(post.event.starts_at, post.event.timezone)}{post.event.venue || post.event.city ? ` · ${[post.event.venue, post.event.city].filter(Boolean).join(', ')}` : ''}</span></span>
            <span className="btn sm">View plan</span>
          </Link>
        )}
        {comments > 0 && <Link to={`/app/posts/${post.id}`} className="igp-all">View {comments === 1 ? '1 comment' : `all ${compactNumber(comments)} comments`}</Link>}
        <p className="igp-date"><Link to={`/app/posts/${post.id}`}>{dayLabel(post.created_at)}</Link>{post.edited_at ? ' · edited' : ''} · <span title={`Visible to: ${Vis.label}`}><Vis.icon size={11} aria-hidden style={{ verticalAlign: '-1px' }} /> {Vis.label}</span></p>
      </div>

      {menu && (
        <Sheet title="Post options" onClose={() => setMenu(false)}>
          <div className="stack" style={{ gap: 8 }}>
            {mine && <button className="btn" onClick={() => { setMenu(false); setEditing(true) }}>Edit caption</button>}
            {mine && <button className="btn danger" onClick={remove}>Delete post</button>}
            {post.music_url && <a className="btn" href={post.music_url} target="_blank" rel="noopener noreferrer nofollow ugc" onClick={() => setMenu(false)}><ExternalLink size={18} aria-hidden /> Listen to {post.music_title ?? 'the song'}</a>}
            {!mine && !post.org && <button className="btn" onClick={() => { setMenu(false); void follow() }} disabled={!canFollow}>{following.has(post.author) ? 'Following' : 'Follow'}</button>}
            {!mine && <button className="btn" onClick={() => { setMenu(false); setReport(true) }}>Report post</button>}
            <button className="btn ghost" onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
      {report && <ReportSheet target={{ type: 'post', id: post.id }} onClose={() => setReport(false)} />}
    </article>
  )
}
