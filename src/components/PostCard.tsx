import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bookmark, Globe, Heart, MessageCircle, MoreHorizontal, Share2, Users, UsersRound } from 'lucide-react'
import type { Post } from '../lib/types'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { Avatar, Sheet, errMsg, toast } from '../ui'
import { timeAgo } from '../lib/format'
import { sharePost } from '../lib/posts'
import { ReportSheet } from './Report'
import { formatEventTime } from '../lib/format'
import { CalendarDays, MapPin, Pause, Play, Music2 } from 'lucide-react'
import { MediaGallery } from './MediaGallery'
import { VerifiedBadge } from './VerifiedBadge'
import { moodOf, moodText } from '../lib/social'
import { TrackArt, useTrackPlayer } from '../pages/create/pickers'
import { playSound } from '../lib/sounds'

const VIS = {
  public: { icon: Globe, label: 'Public' },
  friends: { icon: Users, label: 'Friends' },
  community: { icon: UsersRound, label: 'Community' },
}

export function PostCard({ post, onChange, onDeleted, why }: { post: Post; onChange: (p: Post) => void; onDeleted: (id: string) => void; why?: string }) {
  const { uid } = useAuth()
  const [menu, setMenu] = useState(false)
  const [report, setReport] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(post.body)
  const liked = post.mine_reaction.length > 0
  const saved = post.mine_save.length > 0
  const mine = post.author === uid
  const Vis = VIS[post.visibility]
  const [playing, toggleTrack] = useTrackPlayer()
  const mood = moodOf(post.feeling)
  const gallery = (post.post_media?.length ? [...post.post_media].sort((a, b) => a.sort - b.sort) : post.media_path && post.media_type ? [{ path: post.media_path, type: post.media_type }] : [])
  const tagged = post.tags ?? []
  const hasExtras = Boolean(mood || post.place_name || tagged.length)

  // Optimistic toggles with rollback on failure.
  const toggleLike = async () => {
    const prev = post
    const delta = liked ? -1 : 1
    playSound(liked ? 'unlike' : 'like')
    onChange({ ...post, mine_reaction: liked ? [] : [{ user_id: uid! }], reactions: [{ count: Math.max(0, (post.reactions[0]?.count ?? 0) + delta) }] })
    const { error } = liked
      ? await supabase.from('reactions').delete().eq('post_id', post.id).eq('user_id', uid!)
      : await supabase.from('reactions').insert({ post_id: post.id, user_id: uid })
    if (error && error.code !== '23505') { onChange(prev); toast(errMsg(error)) }
  }
  const toggleSave = async () => {
    const prev = post
    onChange({ ...post, mine_save: saved ? [] : [{ user_id: uid! }] })
    const { error } = saved
      ? await supabase.from('saves').delete().eq('post_id', post.id).eq('user_id', uid!)
      : await supabase.from('saves').insert({ post_id: post.id, user_id: uid })
    if (error && error.code !== '23505') { onChange(prev); toast(errMsg(error)) }
    else toast(saved ? 'Removed from saved' : 'Saved privately')
  }
  const share = async () => { const r = await sharePost(post.id, post.body.slice(0, 80)); if (r !== 'cancelled') playSound('share'); if (r === 'copied') toast('Link copied') }
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
    <article className="post" aria-label={`Post by ${post.profiles.display_name || post.profiles.username}`}>
      <div className="row" style={{ marginBottom: 8 }}>
        <Link to={`/app/u/${post.profiles.username}`} aria-label={`${post.profiles.display_name || post.profiles.username} profile`}><Avatar path={post.profiles.avatar_path} name={post.profiles.display_name || post.profiles.username} /></Link>
        <div className="grow">
          <Link to={`/app/u/${post.profiles.username}`} className="t-name clamp-1" style={{ display: 'block' }}>{post.org ? post.org.name : (post.profiles.display_name || post.profiles.username)}{!post.org && <VerifiedBadge profile={post.profiles} />}</Link>
          <div className="t-meta row" style={{ gap: 6 }}>
            {post.org ? <span>Page · posted by @{post.profiles.username}</span> : <span>@{post.profiles.username}</span>}<span aria-hidden>·</span>
            <Link to={`/app/posts/${post.id}`}>{timeAgo(post.created_at)}</Link>
            {post.edited_at && <span>(edited)</span>}<span aria-hidden>·</span>
            <span className="row" style={{ gap: 3 }} title={`Visible to: ${Vis.label}`}><Vis.icon size={12} aria-hidden /> {Vis.label}</span>
          </div>
        </div>
        <button className="icon-btn" aria-label="More options" aria-haspopup="dialog" onClick={() => setMenu(true)}><MoreHorizontal size={20} /></button>
      </div>
      {why && <p className="t-meta" style={{ marginBottom: 6 }}>{why}</p>}
      {hasExtras && (
        <p className="post-with">
          {mood && <span>{mood.emoji} {moodText(mood)}</span>}
          {post.place_name && <span><MapPin size={13} aria-hidden /> {post.place_name}</span>}
          {tagged.length > 0 && <span>with {tagged.slice(0, 2).map((t, i) => <span key={t.profiles.id}>{i > 0 && ', '}<Link to={`/app/u/${t.profiles.username}`}>{t.profiles.display_name || t.profiles.username}</Link></span>)}{tagged.length > 2 ? ` and ${tagged.length - 2} ${tagged.length === 3 ? 'other' : 'others'}` : ''}</span>}
        </p>
      )}
      {editing ? (
        <div className="stack" style={{ gap: 8 }}>
          <textarea className="textarea" aria-label="Edit post" value={draft} onChange={e => setDraft(e.target.value)} maxLength={5000} />
          <div className="row"><button className="btn sm primary" onClick={saveEdit}>Save</button><button className="btn sm" onClick={() => { setEditing(false); setDraft(post.body) }}>Cancel</button></div>
        </div>
      ) : post.body && <p style={{ whiteSpace: 'pre-wrap' }}>{post.body}</p>}
      {post.event && post.event.status === 'active' && (
        <Link to={`/app/plans/${post.event.id}`} className="shared-plan">
          <CalendarDays size={20} aria-hidden /><span className="grow"><span className="t-name clamp-1" style={{ display: 'block' }}>{post.event.title}</span>
            <span className="t-meta clamp-1" style={{ display: 'block' }}>{formatEventTime(post.event.starts_at, post.event.timezone)}{post.event.venue || post.event.city ? ` · ${[post.event.venue, post.event.city].filter(Boolean).join(', ')}` : ''}</span></span>
          <span className="btn sm">View plan</span>
        </Link>
      )}
      {gallery.length > 0 && <div style={{ marginTop: 10 }}><MediaGallery items={gallery} /></div>}
      {post.music_title && (
        <div className="post-song">
          <TrackArt path={post.track?.artwork_path} size={48} />
          <span className="grow" style={{ minWidth: 0 }}><span className="t-meta"><Music2 size={12} aria-hidden /> Listening to</span><span className="t-name clamp-1" style={{ display: 'block' }}>{post.music_title}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{post.music_artist}</span></span>
          {post.music_track_id && post.track?.preview_path && <button className="icon-btn round" aria-label={playing === post.music_track_id ? 'Pause preview' : `Play a preview of ${post.music_title}`} onClick={() => toggleTrack({ id: post.music_track_id!, preview_path: post.track!.preview_path })}>{playing === post.music_track_id ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>}
          {post.music_url && <a className="btn sm" href={post.music_url} target="_blank" rel="noopener noreferrer nofollow ugc">Listen</a>}
        </div>
      )}
      <div className="actions" style={{ marginTop: 6 }}>
        <button className="icon-btn" aria-pressed={liked} aria-label={liked ? 'Remove like' : 'Like'} onClick={toggleLike}><Heart size={22} fill={liked ? 'currentColor' : 'none'} /></button>
        <span className="count">{post.reactions[0]?.count || ''}</span>
        <Link className="icon-btn" aria-label={`Comments, ${post.comments[0]?.count ?? 0}`} to={`/app/posts/${post.id}`}><MessageCircle size={22} /></Link>
        <span className="count">{post.comments[0]?.count || ''}</span>
        <button className="icon-btn" aria-label="Share" onClick={share}><Share2 size={22} /></button>
        <div className="grow" />
        <button className="icon-btn" aria-pressed={saved} aria-label={saved ? 'Unsave' : 'Save'} onClick={toggleSave}><Bookmark size={22} fill={saved ? 'currentColor' : 'none'} /></button>
      </div>
      {menu && (
        <Sheet title="Post options" onClose={() => setMenu(false)}>
          <div className="stack" style={{ gap: 8 }}>
            {mine && <button className="btn" onClick={() => { setMenu(false); setEditing(true) }}>Edit post</button>}
            {mine && <button className="btn danger" onClick={remove}>Delete post</button>}
            {!mine && <button className="btn" onClick={() => { setMenu(false); setReport(true) }}>Report post</button>}
            <button className="btn ghost" onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
      {report && <ReportSheet target={{ type: 'post', id: post.id }} onClose={() => setReport(false)} />}
    </article>
  )
}
