import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Camera, MoreHorizontal, Play, Plus, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { loadRelations } from '../lib/friends'
import { fetchPosts } from '../lib/posts'
import { checkAvatarFile, saveAvatar, saveCover } from '../lib/avatar'
import { compactNumber, getProfileDetails, profileStats } from '../lib/social'
import { isMissingSchema } from '../lib/tickets'
import { FriendButton } from '../components/FriendButton'
import { FollowButton } from '../components/discover/FollowButton'
import { Feed } from '../components/Feed'
import { ReportSheet } from '../components/Report'
import { ImageCropper } from '../components/ImageCropper'
import { DetailsCard } from '../components/ProfileDetails'
import { VerifiedBadge } from '../components/VerifiedBadge'
import { Avatar, Empty, ErrorState, Sheet, Spinner, Tabs, errMsg, toast, useSigned } from '../ui'
import type { Profile } from '../lib/types'

type Tab = 'all' | 'photos' | 'shots'
const COLS = 'id,username,display_name,bio,avatar_path,location,interests,dm_policy'

export default function ProfilePage() {
  const { username } = useParams()
  const [params, setParams] = useSearchParams()
  const { uid, refreshProfile } = useAuth()
  const nav = useNavigate()
  const [report, setReport] = useState(false)
  const [menu, setMenu] = useState(false)
  const [tab, setTab] = useState<Tab>('all')
  const [crop, setCrop] = useState<{ file: File; kind: 'avatar' | 'cover' } | null>(null)
  const avatarIn = useRef<HTMLInputElement>(null), coverIn = useRef<HTMLInputElement>(null)
  const viewAs = params.get('as') === 'public' ? 'public' : params.get('as') === 'friend' ? 'friend' : null

  const prof = useAsync(async () => {
    const run = (cols: string) => supabase.from('profiles').select(cols).eq('username', (username ?? '').toLowerCase()).maybeSingle()
    let { data, error } = await run(`${COLS},cover_path,verified_until,follow_policy`)
    if (error && isMissingSchema(error)) ({ data, error } = await run(COLS))
    if (error) throw error
    return data as unknown as Profile | null
  }, [username])
  const p = prof.data
  const rel = useAsync(async () => (await loadRelations(uid!)).get(p?.id ?? ''), [uid, p?.id])
  const stats = useAsync(() => (p ? profileStats(p.id) : Promise.resolve(null)), [p?.id])
  const details = useAsync(() => (p ? getProfileDetails(p.id, p.id === uid ? viewAs : null) : Promise.resolve(null)), [p?.id, viewAs])
  const highlights = useAsync(async () => {
    if (!p) return []
    const { data } = await supabase.rpc('author_memories', { p_author: p.id, p_highlights: true })
    return (Array.isArray(data) ? data : []) as { id: string; kind: string; media_path: string | null; text_body: string; bg: string; highlight_title: string | null }[]
  }, [p?.id])
  const cover = useSigned(p?.cover_path)
  useEffect(() => { document.title = p ? `${p.display_name || p.username} · VYBE` : 'Profile · VYBE' }, [p])

  if (prof.loading) return <Spinner />
  if (prof.error) return <ErrorState message={prof.error} onRetry={prof.reload} />
  if (!p) return <Empty title="Profile not found">This person doesn't exist or isn't available to you.</Empty>
  const mine = p.id === uid
  const preview = mine && viewAs
  const isOwnerView = mine && !preview
  const name = p.display_name || p.username

  const message = async () => {
    const { data, error } = await supabase.rpc('start_dm', { other: p.id })
    if (error) return toast(errMsg(error))
    nav(`/app/messages/${data}`)
  }
  const block = async () => {
    if (!confirm(`Block @${p.username}? They won't be able to see your content or message you.`)) return
    const { error } = await supabase.from('blocks').insert({ blocker: uid, blocked: p.id })
    if (error) return toast(errMsg(error))
    toast('Blocked'); nav('/app', { replace: true })
  }
  const pickImage = (kind: 'avatar' | 'cover', f?: File) => { if (!f) return; const bad = checkAvatarFile(f); if (bad) toast(bad); else setCrop({ file: f, kind }) }
  const doneCrop = async (f: File) => {
    const k = crop!.kind; setCrop(null)
    try { if (k === 'avatar') await saveAvatar(uid!, f, p.avatar_path); else await saveCover(uid!, f, p.cover_path); await refreshProfile(); prof.reload(); toast(k === 'avatar' ? 'Photo updated' : 'Cover updated') } catch (e) { toast(errMsg(e)) }
  }
  const s = stats.data

  return (
    <div className="prof">
      {preview && <div className="notice prof-as" role="status"><span>Viewing your profile as <b>{viewAs === 'public' ? 'the public' : 'a friend'}</b>.</span><button className="btn sm" onClick={() => setParams({}, { replace: true })}>Exit</button></div>}
      <div className="prof-cover" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        {isOwnerView && <button className="prof-cam cover" aria-label="Change cover photo" onClick={() => coverIn.current?.click()}><Camera size={20} /></button>}
      </div>
      <header className="prof-head">
        <div className="prof-avatar">
          <Avatar size="lg" path={p.avatar_path} name={name} />
          {isOwnerView && <button className="prof-cam" aria-label="Change profile photo" onClick={() => avatarIn.current?.click()}><Camera size={16} /></button>}
        </div>
        <h1 className="prof-name">{name}<VerifiedBadge profile={p} size={22} /></h1>
        <p className="prof-handle">@{p.username}</p>
        {p.bio && <p className="prof-bio">{p.bio}</p>}
        <p className="prof-stats" aria-label="Profile statistics">
          <span><b>{s ? compactNumber(s.friends) : '–'}</b> friends</span>
          {s?.followers != null && <span><b>{compactNumber(s.followers)}</b> followers</span>}
          {s?.following != null && <span><b>{compactNumber(s.following)}</b> following</span>}
        </p>
        {!preview && (
          <div className="prof-actions">
            {mine ? <>
              <Link className="btn primary" to="/app/memories/new"><Plus size={18} aria-hidden /> Share a memory</Link>
              <Link className="btn" to="/app/profile/edit">Edit profile</Link>
              <Link className="btn icon" to="/app/profile/settings" aria-label="Profile settings"><MoreHorizontal size={20} /></Link>
            </> : <>
              <FriendButton other={p.id} rel={rel.data ?? undefined} onChanged={() => { rel.reload(); stats.reload() }} />
              <FollowButton type="profile" id={p.id} following={Boolean(s?.i_follow)} onChange={() => stats.reload()} label={name} />
              <button className="btn sm" onClick={message}>Message</button>
              <button className="btn sm icon" aria-label="More" onClick={() => setMenu(true)}><MoreHorizontal size={18} /></button>
            </>}
          </div>
        )}
      </header>

      {(highlights.data?.length ?? 0) > 0 && (
        <section aria-label="Highlights" className="prof-hl">
          <ul className="hscroll">{highlights.data!.map(h => <li key={h.id}><HighlightTile h={h} authorId={p.id} /></li>)}</ul>
        </section>
      )}

      <Tabs value={tab} onChange={setTab} items={[{ id: 'all', label: 'All' }, { id: 'photos', label: 'Photos' }, { id: 'shots', label: 'Shots' }]} />

      {tab === 'all' && (
        <div className="prof-grid">
          <aside className="prof-side" aria-label="About">
            {details.loading ? <Spinner /> : <DetailsCard d={details.data} interests={mine && !preview ? p.interests : (details.data?.level ?? 1) >= 1 ? p.interests : []} empty={mine && !preview ? 'Add your details from Edit profile.' : `${name} hasn’t shared details with you.`} />}
            {isOwnerView && <Link className="btn" to="/app/profile/edit">Edit details</Link>}
          </aside>
          <section className="prof-main" aria-label="Posts">
            {isOwnerView && (
              <div className="compose-bar" style={{ marginBottom: 8 }}>
                <Avatar path={p.avatar_path} name={name} />
                <button className="compose-pill" onClick={() => nav('/app/create')}>What’s on your mind, {name.split(' ')[0]}?</button>
                <button className="icon-btn" aria-label="Add a photo or video" onClick={() => nav('/app/create')}><Camera size={24} /></button>
              </div>
            )}
            <h2 className="t-section" style={{ margin: '8px 0 4px' }}>Posts</h2>
            <Feed key={viewAs ?? 'me'} load={c => fetchPosts({ uid: uid!, cursor: c, author: p.id, publicOnly: Boolean(preview && viewAs === 'public') })} deps={[p.id, viewAs]}
              empty={{ title: 'No posts to show', text: mine ? 'Share your first post.' : 'Nothing visible to you yet.', action: isOwnerView ? <Link className="btn primary" to="/app/create">Create a post</Link> : undefined }} />
          </section>
        </div>
      )}
      {tab !== 'all' && <MediaGrid authorId={p.id} type={tab === 'photos' ? 'image' : 'video'} publicOnly={Boolean(preview && viewAs === 'public')} mine={isOwnerView} />}

      {menu && (
        <Sheet title={name} onClose={() => setMenu(false)}>
          <div className="stack" style={{ gap: 8 }}>
            <button className="btn" onClick={() => { setMenu(false); setReport(true) }}>Report</button>
            <button className="btn danger" onClick={() => { setMenu(false); void block() }}>Block</button>
            <button className="btn ghost" onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
      {report && <ReportSheet target={{ type: 'profile', id: p.id }} onClose={() => setReport(false)} />}
      {crop && <ImageCropper file={crop.file} shape={crop.kind} onCancel={() => setCrop(null)} onDone={doneCrop} />}
      <input ref={avatarIn} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={e => { pickImage('avatar', e.target.files?.[0]); e.target.value = '' }} />
      <input ref={coverIn} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif" onChange={e => { pickImage('cover', e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

function HighlightTile({ h, authorId }: { h: { id: string; kind: string; media_path: string | null; text_body: string; bg: string; highlight_title: string | null }; authorId: string }) {
  const url = useSigned(h.kind === 'photo' ? h.media_path : null)
  return (
    <Link to={`/app/memories/${authorId}?h=1&m=${h.id}`} className="hl" aria-label={`Highlight ${h.highlight_title ?? ''}`}>
      <span className="hl-art" style={url ? { backgroundImage: `url(${url})` } : { background: 'linear-gradient(160deg, #7a5cff, #3b2a8f)' }}>{h.kind === 'video' && <Play size={18} fill="currentColor" aria-hidden />}</span>
      <span className="hl-label clamp-1">{h.highlight_title || 'Highlight'}</span>
    </Link>
  )
}

/** Photos / Shots: every photo or video from the person's visible posts, newest first. Falls back to the single-media column before the gallery migration. */
function MediaGrid({ authorId, type, publicOnly, mine }: { authorId: string; type: 'image' | 'video'; publicOnly: boolean; mine: boolean }) {
  const list = useAsync(async () => {
    let q = supabase.from('post_media').select('post_id,path,type,posts!inner(author,created_at,visibility)').eq('posts.author', authorId).eq('type', type).limit(90)
    if (publicOnly) q = q.eq('posts.visibility', 'public')
    const r = await q
    if (!r.error) return ((r.data ?? []) as unknown as { post_id: string; path: string; posts: { created_at: string } }[]).sort((a, b) => b.posts.created_at.localeCompare(a.posts.created_at))
    if (!isMissingSchema(r.error)) throw r.error
    let q2 = supabase.from('posts').select('id,media_path,created_at').eq('author', authorId).eq('media_type', type).order('created_at', { ascending: false }).limit(90)
    if (publicOnly) q2 = q2.eq('visibility', 'public')
    const r2 = await q2
    if (r2.error) throw r2.error
    return (r2.data ?? []).map(x => ({ post_id: x.id, path: x.media_path!, posts: { created_at: x.created_at } }))
  }, [authorId, type, publicOnly])
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data?.length) return <Empty title={type === 'image' ? 'No photos yet' : 'No shots yet'} action={mine ? <Link className="btn primary" to="/app/create">Create a post</Link> : undefined}>{type === 'image' ? 'Photos from posts appear here.' : 'Short videos from posts appear here.'}</Empty>
  return <ul className="shots" aria-label={type === 'image' ? 'Photos' : 'Shots'}>{list.data.map(m => <li key={m.path}><ShotTile postId={m.post_id} path={m.path} type={type} /></li>)}</ul>
}
function ShotTile({ postId, path, type }: { postId: string; path: string; type: 'image' | 'video' }) {
  const url = useSigned(path)
  return (
    <Link to={`/app/posts/${postId}`} className={`shot${type === 'video' ? ' v' : ''}`} aria-label={type === 'video' ? 'Open video post' : 'Open photo post'}>
      {!url ? <span className="skeleton" style={{ position: 'absolute', inset: 0 }} /> : type === 'video' ? <><video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden /><span className="shot-play" aria-hidden><Play size={20} fill="currentColor" /></span></> : <img src={url} alt="" loading="lazy" decoding="async" />}
    </Link>
  )
}
void X
