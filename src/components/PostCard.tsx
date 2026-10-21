import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bookmark, CalendarDays, Globe, Heart, MapPin, MessageCircle, MoreHorizontal, Music2, Pause, Play, Send, Users, UsersRound } from 'lucide-react'
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
import { useTrackPlayer } from '../pages/create/pickers'

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
 * Instagram-style post card: header (avatar, name, tick, song or place, Follow, menu), edge-to-edge media at its original size,
 * an actions row with counts, then the caption written below the media. Double-tap the media to like.
 */
export function PostCard({ post, onChange, onDeleted, why }: { post: Post; onChange: (p: Post) => void; onDeleted: (id: string) => void; why?: string }) {
  const { uid } = useAuth()
  const live = useLiveProfiles()
  const author = live(post.profiles)
  const following = useFollowing(uid)
  const [menu, setMenu] = useState(false)
  const [report, setReport] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(post.body)
  const [more, setMore] = useState(false)
  const [playing, toggleTrack, toggleSigned] = useTrackPlayer()
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
    const paths = [...new Set([post.media_path, ...(post.post_media ?? []).map(m => m.path)].filter((x): x is string => Boolean(x)))]
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
    <article className="igp" aria-label={`Post by ${name}`}>
      <header className="igp-h">
        <Link to={`/app/u/${author.username}`} aria-label={`${author.display_name || author.username} profile`}><Avatar path={author.avatar_path} uid={author.id} name={author.display_name || author.username} /></Link>
        <div className="igp-who">
          <Link to={`/app/u/${author.username}`} className="igp-name">{name}{!post.org && <VerifiedBadge profile={author} />}</Link>
          {post.music_title
            ? <span className="igp-sub"><Music2 size={12} aria-hidden /> {post.music_artist} · {post.music_title}</span>
            : post.place_name ? <span className="igp-sub"><MapPin size={12} aria-hidden /> {post.place_name}</span>
            : post.org ? <span className="igp-sub">Page · @{author.username}</span> : null}
        </div>
        {post.music_track_id && post.track?.preview_path && <button className="icon-btn round sm" aria-label={playing === post.music_track_id ? 'Pause preview' : `Play a preview of ${post.music_title}`} onClick={() => toggleTrack({ id: post.music_track_id!, preview_path: post.track!.preview_path })}>{playing === post.music_track_id ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>}
        {post.music_path && <button className="icon-btn round sm" aria-label={playing === post.id ? 'Pause song' : `Play ${post.music_title ?? 'the song'}`} onClick={() => void toggleSigned(post.id, post.music_path!)}>{playing === post.id ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>}
        {post.music_url && <a className="igp-follow" href={post.music_url} target="_blank" rel="noopener noreferrer nofollow ugc">Listen</a>}
        {canFollow && <button className="igp-follow" onClick={follow} aria-label={`Follow ${author.display_name || author.username}`}>Follow</button>}
        <button className="icon-btn" aria-label="More options" aria-haspopup="dialog" onClick={() => setMenu(true)}><MoreHorizontal size={22} /></button>
      </header>
      {why && <p className="igp-why">{why}</p>}

      {gallery.length > 0
        ? <PostMedia items={gallery} liked={liked} onDoubleTap={() => setLike(true)} />
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
