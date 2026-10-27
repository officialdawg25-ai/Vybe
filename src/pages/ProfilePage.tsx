import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Camera, ChevronLeft, Clapperboard, Ellipsis, Heart, Images, LayoutGrid, Link2, MessageCircle, Pencil, Play, Plus, Settings2, Share2, SquarePlus, UserRound, UserSquare } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { useChromeless } from '../lib/chrome'
import { loadRelations } from '../lib/friends'
import { MOTION_MAX_SECONDS, checkAvatarFile, readClip, saveAvatar, saveCover, saveMotionAvatar } from '../lib/avatar'
import { compactNumber, getProfileDetails, profileStats } from '../lib/social'
import { isMissingSchema } from '../lib/tickets'
import { FriendButton } from '../components/FriendButton'
import { FollowButton } from '../components/discover/FollowButton'
import { ReportSheet } from '../components/Report'
import { ImageCropper } from '../components/ImageCropper'
import { DetailsCard } from '../components/ProfileDetails'
import { VerifiedBadge } from '../components/VerifiedBadge'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import type { Profile } from '../lib/types'

type Tab = 'posts' | 'shots' | 'tagged' | 'about'
const COLS = 'id,username,display_name,bio,avatar_path,location,interests,dm_policy'
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Instagram-style profile: top bar, avatar with a ring when there are live memories, posts/followers/following, bio, mutual followers, wide action buttons, highlights, icon tabs and a media grid. */
export default function ProfilePage() {
  const { username } = useParams()
  const [params, setParams] = useSearchParams()
  const { uid, refreshProfile } = useAuth()
  const nav = useNavigate()
  useChromeless()
  const [report, setReport] = useState(false)
  const [menu, setMenu] = useState(false)
  const [tab, setTab] = useState<Tab>('posts')
  const [crop, setCrop] = useState<{ file: File; kind: 'avatar' | 'cover' } | null>(null)
  const avatarIn = useRef<HTMLInputElement>(null), coverIn = useRef<HTMLInputElement>(null)
  const viewAs = params.get('as') === 'public' ? 'public' : params.get('as') === 'friend' ? 'friend' : null

  const prof = useAsync(async () => {
    const run = (cols: string) => supabase.from('profiles').select(cols).eq('username', (username ?? '').toLowerCase()).maybeSingle()
    let { data, error } = await run(`${COLS},cover_path,verified_until,follow_policy,avatar_motion_path`)
    if (error && isMissingSchema(error)) ({ data, error } = await run(`${COLS},cover_path,verified_until,follow_policy`))
    if (error && isMissingSchema(error)) ({ data, error } = await run(COLS))
    if (error) throw error
    return data as unknown as Profile | null
  }, [username])
  const p = prof.data
  const rel = useAsync(async () => (await loadRelations(uid!)).get(p?.id ?? ''), [uid, p?.id])
  const stats = useAsync(() => (p ? profileStats(p.id) : Promise.resolve(null)), [p?.id])
  const details = useAsync(() => (p ? getProfileDetails(p.id, p.id === uid ? viewAs : null) : Promise.resolve(null)), [p?.id, viewAs])
  const fby = useAsync(async () => {
    if (!p || p.id === uid) return null
    const { data, error } = await supabase.rpc('profile_followed_by', { p_user: p.id })
    return error ? null : (data as { count: number; people: { username: string; display_name: string; avatar_path: string | null }[] })
  }, [p?.id])
  const memories = useAsync(async () => {
    if (!p) return { live: [] as { id: string; seen: boolean }[], hl: [] as { id: string; kind: string; media_path: string | null; text_body: string; bg: string; highlight_title: string | null }[] }
    const [live, hl] = await Promise.all([supabase.rpc('author_memories', { p_author: p.id, p_highlights: false }), supabase.rpc('author_memories', { p_author: p.id, p_highlights: true })])
    return { live: (Array.isArray(live.data) ? live.data : []) as { id: string; seen: boolean }[], hl: (Array.isArray(hl.data) ? hl.data : []) as { id: string; kind: string; media_path: string | null; text_body: string; bg: string; highlight_title: string | null }[] }
  }, [p?.id])
  const cover = useSigned(p?.cover_path)
  const motion = useSigned(p?.avatar_motion_path)
  const art = useSigned(p?.avatar_path)
  const [busy, setBusy] = useState(false)
  useEffect(() => { document.title = p ? `${p.display_name || p.username} · VYBE` : 'Profile · VYBE' }, [p])

  if (prof.loading) return <Spinner />
  if (prof.error) return <ErrorState message={prof.error} onRetry={prof.reload} />
  if (!p) return <Empty title="Profile not found">This person doesn't exist or isn't available to you.</Empty>
  const mine = p.id === uid
  const preview = mine && viewAs
  const owner = mine && !preview
  const name = p.display_name || p.username
  const s = stats.data
  const live = memories.data?.live ?? []
  const hasStory = live.length > 0
  const link = details.data?.links?.[0]

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
  const share = async () => { const url = `${window.location.origin}/app/u/${p.username}`; if (navigator.share) { try { await navigator.share({ url, title: name }) } catch { /* dismissed */ } } else { await navigator.clipboard.writeText(url); toast('Profile link copied') } }
  const pickImage = async (kind: 'avatar' | 'cover', f?: File) => {
    if (!f) return
    if (kind === 'cover' && !/^image\/(jpeg|png|webp)$/.test(f.type)) return toast('A cover is a photo: choose a JPG, PNG or WebP image.')
    const bad = checkAvatarFile(f); if (bad) return toast(bad)
    if (kind === 'avatar' && f.type.startsWith('video/')) {                    // a short clip: still frame for the app, the clip for this screen
      setBusy(true)
      try {
        const { seconds, poster } = await readClip(f)
        if (seconds > MOTION_MAX_SECONDS) throw new Error(`Choose a clip of about 5 seconds (yours is ${Math.round(seconds)} s).`)
        await saveMotionAvatar(uid!, f, poster, { avatar: p!.avatar_path, motion: p!.avatar_motion_path })
        await refreshProfile(); prof.reload(); toast('Profile clip updated')
      } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
      return
    }
    if (kind === 'avatar' && f.type === 'image/gif') {                         // a GIF is kept as it is (cropping would flatten it)
      setBusy(true)
      try { await saveAvatar(uid!, f, p!.avatar_path); await refreshProfile(); prof.reload(); toast('Photo updated') } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
      return
    }
    setCrop({ file: f, kind })
  }
  const doneCrop = async (f: File) => {
    const k = crop!.kind; setCrop(null)
    try { if (k === 'avatar') await saveAvatar(uid!, f, p.avatar_path); else await saveCover(uid!, f, p.cover_path); await refreshProfile(); prof.reload(); toast(k === 'avatar' ? 'Photo updated' : 'Cover updated') } catch (e) { toast(errMsg(e)) }
  }
  const avatarTap = () => { if (hasStory) nav(`/app/memories/${p.id}`); else if (owner) avatarIn.current?.click() }

  const avatarMedia = (
    <span className="pf-av-media">
      <Avatar size="lg" path={p.avatar_path} name={name} />
      {motion && !reduced() && <video className="pf-av-video" src={motion} poster={art ?? undefined} muted loop autoPlay playsInline preload="auto" aria-hidden />}
    </span>
  )
  return (
    <div className="igprof pf">
      <div className={`pf-hero${cover ? ' has-cover' : ''}`}>
        <div className="pf-hero-img" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden />
        <div className="pf-hero-shade" aria-hidden />
        <header className="pf-bar">
          {owner || preview
            ? <><span className="pf-pill">@{p.username}</span><span className="grow" />
                <Link className="pf-ibtn" to="/app/create" aria-label="Create a post"><SquarePlus size={22} /></Link>
                <Link className="pf-ibtn" to="/app/profile/settings" aria-label="Profile settings"><Settings2 size={22} /></Link></>
            : <><button className="pf-ibtn" aria-label="Back" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/app'))}><ChevronLeft size={24} /></button><span className="grow" />
                <button className="pf-ibtn" aria-label="More options" onClick={() => setMenu(true)}><Ellipsis size={22} /></button></>}
        </header>
        {owner && <button className="pf-cam" aria-label={cover ? 'Change cover photo' : 'Add a cover photo'} onClick={() => coverIn.current?.click()}><Camera size={18} /><span>{cover ? 'Edit cover' : 'Add cover'}</span></button>}
      </div>
      {preview && <div className="notice prof-as" role="status"><span>Viewing your profile as <b>{viewAs === 'public' ? 'the public' : 'a friend'}</b>.</span><button className="btn sm" onClick={() => setParams({}, { replace: true })}>Exit</button></div>}

      <section className="pf-card" aria-label="Profile">
        <div className="pf-av">
          <button className={`ig-ring pf-ring${hasStory ? (live.some(m => !m.seen) && !mine ? ' new' : ' seen') : ''}${busy ? ' busy' : ''}`} onClick={avatarTap} disabled={busy} aria-label={hasStory ? `View ${mine ? 'your' : `${name}'s`} memories` : owner ? 'Change profile photo' : `${name}'s photo`}>
            {avatarMedia}
          </button>
          {owner && <button className="pf-av-edit" aria-label="Change profile picture, GIF or short clip" onClick={() => avatarIn.current?.click()}><Pencil size={14} /></button>}
          {owner && <Link to="/app/memories/new" className="ig-plus" aria-label="Share a memory"><Plus size={16} strokeWidth={3} /></Link>}
        </div>
        <h1 className="pf-name">{name}<VerifiedBadge profile={p} size={20} /></h1>
        <p className="pf-handle">@{p.username}{s && (s.friends > 0 || (!mine && s.follows_me)) ? <span> · {s.friends > 0 ? `${compactNumber(s.friends)} ${s.friends === 1 ? 'friend' : 'friends'}` : ''}{!mine && s.follows_me ? `${s.friends > 0 ? ' · ' : ''}Follows you` : ''}</span> : null}</p>
        <ul className="pf-stats" aria-label="Profile statistics">
          <li><b>{s?.posts != null ? compactNumber(s.posts) : '–'}</b><span>Posts</span></li>
          <li><b>{s?.followers != null ? compactNumber(s.followers) : '–'}</b><span>Followers</span></li>
          <li><b>{s?.following != null ? compactNumber(s.following) : '–'}</b><span>Following</span></li>
        </ul>
        {p.bio && <p className="pf-bio">{p.bio}</p>}
        {link && <a className="igbio-link" href={link.url} target="_blank" rel="noopener noreferrer nofollow ugc"><Link2 size={14} aria-hidden /> {link.label || link.url.replace(/^https:\/\//, '')}</a>}
        {fby.data && fby.data.count > 0 && (
          <p className="igbio-by"><span className="avatar-stack">{fby.data.people.map(x => <Avatar key={x.username} size="sm" path={x.avatar_path} name={x.display_name || x.username} />)}</span>
            <span>Followed by {fby.data.people.map(x => x.display_name || x.username).slice(0, 2).join(', ')}{fby.data.count > 2 ? ` and ${fby.data.count - 2} ${fby.data.count === 3 ? 'other' : 'others'}` : ''}</span></p>
        )}
        {!preview && (
          <div className="pf-actions">
            {mine ? <><Link className="btn primary pf-main" to="/app/profile/edit"><Pencil size={16} aria-hidden /> Edit profile</Link><button className="btn pf-icon" onClick={share} aria-label="Share profile"><Share2 size={18} /></button></> : <>
              <FollowButton type="profile" id={p.id} following={Boolean(s?.i_follow)} onChange={() => stats.reload()} label={name} size="md" idleText={s?.follows_me ? 'Follow back' : 'Follow'} className="pf-main" />
              <button className="btn pf-icon" onClick={message} aria-label={`Message ${name}`}><MessageCircle size={18} /></button>
              <button className="btn pf-icon" onClick={share} aria-label="Share profile"><Share2 size={18} /></button>
              <FriendButton other={p.id} rel={rel.data ?? undefined} onChanged={() => { rel.reload(); stats.reload() }} />
            </>}
          </div>
        )}
      </section>

      {(memories.data?.hl.length ?? 0) > 0 && (
        <section aria-label="Highlights" className="prof-hl"><ul className="hscroll">{memories.data!.hl.map(h => <li key={h.id}><HighlightTile h={h} authorId={p.id} /></li>)}</ul></section>
      )}

      <div className="igtabs pf-tabs" role="tablist" aria-label="Profile sections">
        {([['posts', LayoutGrid, 'Posts'], ['shots', Clapperboard, 'Shots'], ['tagged', UserSquare, 'Tagged'], ['about', UserRound, 'About']] as const).map(([k, Ico, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} aria-label={label} title={label} className={`igtab pf-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}><Ico size={22} /><span>{label}</span></button>
        ))}
      </div>

      {tab === 'about' && (
        <div className="prof-side igpad" aria-label="About">
          {details.loading ? <Spinner /> : <DetailsCard d={details.data} interests={p.interests} empty={owner ? 'Add your details from Edit profile.' : `${name} hasn’t shared details with you.`} />}
          {owner && <Link className="btn" to="/app/profile/edit">Edit details</Link>}
        </div>
      )}
      {tab !== 'about' && <Grid authorId={p.id} kind={tab} publicOnly={Boolean(preview && viewAs === 'public')} owner={owner} name={name} />}

      {menu && (
        <Sheet title={name} onClose={() => setMenu(false)}>
          <div className="stack" style={{ gap: 8 }}>
            <button className="btn" onClick={() => { setMenu(false); void share() }}>Share profile</button>
            <button className="btn" onClick={() => { setMenu(false); setReport(true) }}>Report</button>
            <button className="btn danger" onClick={() => { setMenu(false); void block() }}>Block</button>
            <button className="btn ghost" onClick={() => setMenu(false)}>Close</button>
          </div>
        </Sheet>
      )}
      {report && <ReportSheet target={{ type: 'profile', id: p.id }} onClose={() => setReport(false)} />}
      {crop && <ImageCropper file={crop.file} shape={crop.kind} onCancel={() => setCrop(null)} onDone={doneCrop} />}
      <input ref={avatarIn} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" onChange={e => { void pickImage('avatar', e.target.files?.[0]); e.target.value = '' }} />
      <input ref={coverIn} type="file" hidden accept="image/jpeg,image/png,image/webp" onChange={e => { void pickImage('cover', e.target.files?.[0]); e.target.value = '' }} />
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

interface Cell { id: string; body: string; created_at: string; media_path: string | null; media_type: string | null; post_media?: { path: string; type: 'image' | 'video'; sort: number; poster_path?: string | null; display_path?: string | null }[]; reactions?: { count: number }[] }
const CELL = 'id,body,created_at,media_path,media_type,reactions(count)'

/** The media grid: posts (text posts get a text tile), shots (videos) or posts the person is tagged in. Counts are real reaction counts. */
function Grid({ authorId, kind, publicOnly, owner, name }: { authorId: string; kind: 'posts' | 'shots' | 'tagged'; publicOnly: boolean; owner: boolean; name: string }) {
  const list = useAsync(async () => {
    // Gallery with stills (posters, display copies: migrations 20 and 25), without them, or none on an older database.
    const fetchCells = async (gallery: string | null) => {
      const cols = gallery ? `${CELL},post_media(${gallery})` : CELL
      if (kind === 'tagged') {
        const r = await supabase.from('post_tags').select(`post_id,posts!inner(${cols})`).eq('user_id', authorId).limit(90)
        return { data: ((r.data ?? []) as unknown as { posts: Cell }[]).map(x => x.posts), error: r.error }
      }
      let q = supabase.from('posts').select(cols).eq('author', authorId).order('created_at', { ascending: false }).limit(90)
      if (publicOnly) q = q.eq('visibility', 'public')
      if (kind === 'shots') q = q.eq('media_type', 'video')
      const r = await q
      return { data: (r.data ?? []) as unknown as Cell[], error: r.error }
    }
    let r = await fetchCells('path,type,sort,poster_path,display_path')
    if (r.error && isMissingSchema(r.error)) r = await fetchCells('path,type,sort,poster_path')
    if (r.error && isMissingSchema(r.error)) r = await fetchCells('path,type,sort')
    if (r.error && isMissingSchema(r.error)) r = kind === 'tagged' ? { data: [], error: null } : await fetchCells(null)
    if (r.error) throw r.error
    return r.data.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [authorId, kind, publicOnly])
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data?.length) {
    return (
      <div className="igempty">
        <Empty title={kind === 'posts' ? (owner ? 'Create your first post' : 'No posts yet') : kind === 'shots' ? 'No shots yet' : 'No tagged posts'}
          action={owner && kind !== 'tagged' ? <Link className="btn primary" to="/app/create">Create a post</Link> : undefined}>
          {kind === 'posts' ? (owner ? 'Give this space some love.' : `${name} hasn’t shared anything you can see yet.`) : kind === 'shots' ? 'Short videos from posts appear here.' : 'Posts friends tag this person in appear here.'}
        </Empty>
      </div>
    )
  }
  return <ul className={`shots${kind === 'shots' ? ' tall' : ''}`} aria-label={kind}>{list.data.map(c => <li key={c.id}><Tile c={c} tall={kind === 'shots'} /></li>)}</ul>
}

function Tile({ c, tall }: { c: Cell; tall: boolean }) {
  const first: NonNullable<Cell['post_media']>[number] | { path: string; type: 'image' | 'video'; poster_path?: undefined; display_path?: undefined } | null =
    c.post_media?.length ? [...c.post_media].sort((a, b) => a.sort - b.sort)[0] : c.media_path && c.media_type ? { path: c.media_path, type: c.media_type as 'image' | 'video' } : null
  // A tile is small: a photo's display copy, or a video's poster, instead of the original file (a video otherwise loads its first frame).
  const still = first ? (first.type === 'image' ? first.display_path : first.poster_path) ?? null : null
  const url = useSigned(still ?? first?.path)
  const multi = (c.post_media?.length ?? 0) > 1
  const likes = c.reactions?.[0]?.count ?? 0
  return (
    <Link to={`/app/posts/${c.id}`} className={`shot${tall ? ' v' : ''}`} aria-label={first ? (first.type === 'video' ? 'Open video post' : 'Open photo post') : 'Open post'}>
      {!first ? <span className="shot-text clamp-4">{c.body}</span>
        : !url ? <span className="skeleton" style={{ position: 'absolute', inset: 0 }} />
        : first.type === 'video' && !still ? <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden /> : <img src={url} alt="" loading="lazy" decoding="async" />}
      {multi && <span className="shot-multi" aria-label="Several photos"><Images size={16} /></span>}
      {first?.type === 'video' && !multi && <span className="shot-multi" aria-label="Video"><Play size={16} fill="currentColor" /></span>}
      {likes > 0 && <span className="shot-likes"><Heart size={14} fill="currentColor" aria-hidden /> {compactNumber(likes)}</span>}
    </Link>
  )
}
