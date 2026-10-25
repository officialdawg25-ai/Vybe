import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Archive, ArrowLeft, BadgeCheck, ChevronRight, Eye, FileText, Images, Lock, Settings2, Share2, Sparkles, Tag, UserPlus, type LucideIcon } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { supabase } from '../../lib/supabase'
import { MEMORY_BG, authorMemories, type Memory } from '../../lib/social'
import { timeAgo } from '../../lib/format'
import { useAsync } from '../../lib/hooks'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../../ui'
import { sharePost } from '../../lib/posts'
import { isVerified } from '../../lib/social'
import { isMissingSchema } from '../../lib/tickets'

const Back = ({ title, to = '/app/profile/settings' }: { title: string; to?: string }) => (
  <header className="row" style={{ alignItems: 'center', marginBottom: 12 }}><Link className="icon-btn" to={to} aria-label="Back"><ArrowLeft size={22} /></Link><h1 className="t-title">{title}</h1></header>
)
const Radio = <T extends string>({ name, value, onChange, options }: { name: string; value: T; onChange: (v: T) => void; options: { v: T; label: string; hint?: string }[] }) => (
  <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label={name}>
    {options.map(o => (
      <label key={o.v} className={`cp-opt${value === o.v ? ' on' : ''}`}><input type="radio" name={name} checked={value === o.v} onChange={() => onChange(o.v)} style={{ accentColor: 'var(--brand)', width: 20, height: 20 }} />
        <span className="grow"><b>{o.label}</b>{o.hint && <span className="t-meta" style={{ display: 'block' }}>{o.hint}</span>}</span></label>))}
  </div>
)

/* ------------------------------------------------------------------ menu */
export default function ProfileSettings() {
  const { profile } = useAuth()
  useEffect(() => { document.title = 'Profile settings · VYBE' }, [])
  if (!profile) return <Spinner />
  const rows: { to: string; icon: LucideIcon; label: string; hint: string }[] = [
    { to: '/app/profile/edit', icon: Settings2, label: 'Edit profile', hint: 'Details, interests, travel, links, contact' },
    { to: '/app/profile/settings/follow', icon: UserPlus, label: 'Follow settings', hint: 'Who can follow you and see your followers' },
    { to: '/app/profile/settings/highlights', icon: Sparkles, label: 'Highlights', hint: 'Memories pinned to your profile' },
    { to: '/app/profile/settings/archive', icon: Archive, label: 'Archive', hint: 'All your memories, including expired ones' },
    { to: '/app/profile/settings/view-as', icon: Eye, label: 'View as', hint: 'See your profile as the public or a friend' },
    { to: '/app/profile/settings/posts', icon: FileText, label: 'Manage posts', hint: 'Change who sees a post, or delete it' },
    { to: '/app/media', icon: Images, label: 'Media library', hint: 'Your photos and videos, and their upload checks' },
    { to: '/app/profile/settings/tags', icon: Tag, label: 'Review tags', hint: 'Posts you’re tagged in' },
    { to: '/app/profile/settings/privacy', icon: Lock, label: 'Privacy Center', hint: 'Messages, followers, blocked accounts' },
    { to: '/app/profile/settings/verified', icon: BadgeCheck, label: 'VYBE Verified', hint: isVerified(profile) ? 'Your badge is active' : 'Get the blue tick' },
  ]
  const share = async () => { const url = `${window.location.origin}/app/u/${profile.username}`; if (navigator.share) { try { await navigator.share({ url, title: profile.display_name || profile.username }) } catch { /* dismissed */ } } else { await navigator.clipboard.writeText(url); toast('Profile link copied') } }
  return (
    <>
      <Back title="Profile settings" to={`/app/u/${profile.username}`} />
      <ul className="ps-list">
        {rows.map(r => <li key={r.to}><Link to={r.to} className="ps-row"><r.icon size={24} aria-hidden /><span className="grow"><b>{r.label}</b><span className="t-meta" style={{ display: 'block' }}>{r.hint}</span></span><ChevronRight size={20} aria-hidden /></Link></li>)}
        <li><button className="ps-row" onClick={share}><Share2 size={24} aria-hidden /><span className="grow"><b>Share profile</b><span className="t-meta" style={{ display: 'block' }}>Copy or send your profile link</span></span></button></li>
        <li><Link to="/app/settings" className="ps-row"><Settings2 size={24} aria-hidden /><span className="grow"><b>Account settings</b><span className="t-meta" style={{ display: 'block' }}>Notifications, theme, sound, data export</span></span><ChevronRight size={20} aria-hidden /></Link></li>
      </ul>
      <p className="t-meta" style={{ marginTop: 16 }}>Your profile link: <b>{window.location.origin}/app/u/{profile.username}</b></p>
    </>
  )
}

/* ------------------------------------------------------------------ follow */
export function FollowSettings() {
  const { uid, profile, refreshProfile } = useAuth()
  const [policy, setPolicy] = useState<'everyone' | 'friends'>('everyone')
  const [show, setShow] = useState<'public' | 'friends' | 'me'>('public')
  useEffect(() => { if (profile) { setPolicy(profile.follow_policy ?? 'everyone'); setShow(profile.show_followers ?? 'public') } }, [profile])
  const save = async (patch: Record<string, string>) => {
    const { error } = await supabase.from('profiles').update(patch).eq('id', uid!)
    if (error) return toast(errMsg(error)); await refreshProfile(); toast('Saved')
  }
  return (
    <>
      <Back title="Follow settings" />
      <h2 className="t-section" style={{ marginBottom: 8 }}>Who can follow you</h2>
      <Radio name="Who can follow you" value={policy} onChange={v => { setPolicy(v); void save({ follow_policy: v }) }} options={[{ v: 'everyone', label: 'Everyone', hint: 'Anyone on VYBE can follow you' }, { v: 'friends', label: 'Friends only', hint: 'Only people you’re already friends with' }]} />
      <h2 className="t-section" style={{ margin: '24px 0 8px' }}>Who can see your followers and following</h2>
      <Radio name="Who can see your follower counts" value={show} onChange={v => { setShow(v); void save({ show_followers: v }) }} options={[{ v: 'public', label: 'Public' }, { v: 'friends', label: 'Friends' }, { v: 'me', label: 'Only me' }]} />
      <p className="t-meta" style={{ marginTop: 16 }}>Your friend count is always shown to people who can see your profile. Anyone you’ve blocked can’t follow you.</p>
    </>
  )
}

/* ------------------------------------------------------------------ memories lists */
function Thumb({ m }: { m: Memory }) {
  const url = useSigned(m.kind === 'photo' ? m.media_path : null)
  return <span className="arc-thumb" style={m.kind === 'text' ? { background: MEMORY_BG[m.bg] } : url ? { backgroundImage: `url(${url})` } : undefined}>{m.kind === 'video' ? '▶' : m.kind === 'text' ? m.text_body.slice(0, 18) : ''}</span>
}
function useMyMemories() {
  const { uid } = useAuth()
  return useAsync(async () => {
    const { data, error } = await supabase.from('memories').select('id,kind,media_path,text_body,bg,created_at,expires_at,visibility,highlight,highlight_title').eq('author', uid!).order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    return (data ?? []) as Memory[]
  }, [uid])
}
export function ArchivePage({ onlyHighlights = false }: { onlyHighlights?: boolean }) {
  const nav = useNavigate()
  const { uid } = useAuth()
  const list = useMyMemories()
  const rows = (list.data ?? []).filter(m => !onlyHighlights || m.highlight)
  const toggle = async (m: Memory) => {
    const title = m.highlight ? null : (prompt('Name this highlight (optional)', '') ?? '').slice(0, 40) || null
    const { error } = await supabase.from('memories').update({ highlight: !m.highlight, highlight_title: title }).eq('id', m.id)
    if (error) return toast(errMsg(error)); list.reload()
  }
  const del = async (m: Memory) => {
    if (!confirm('Delete this memory permanently?')) return
    const { error } = await supabase.from('memories').delete().eq('id', m.id)
    if (error) return toast(errMsg(error))
    if (m.media_path) await supabase.storage.from('media').remove([m.media_path]); list.reload()
  }
  const live = (m: Memory) => new Date(m.expires_at).getTime() > Date.now()
  return (
    <>
      <Back title={onlyHighlights ? 'Highlights' : 'Archive'} />
      <p className="t-meta" style={{ marginBottom: 12 }}>{onlyHighlights ? 'Highlights stay on your profile after the 24 hours are up.' : 'Everything you’ve shared as a memory. Only you can see expired ones unless you add them to your highlights.'}</p>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !rows.length
        ? <Empty title={onlyHighlights ? 'No highlights yet' : 'Nothing archived yet'} action={<Link className="btn primary" to="/app/memories/new">Share a memory</Link>}>{onlyHighlights ? 'Open a memory, tap ⋯ and choose “Add to highlights”.' : 'Memories you share appear here.'}</Empty>
        : <ul className="arc">{rows.map(m => (
          <li key={m.id} className="arc-row">
            <button className="arc-open" onClick={() => nav(m.highlight ? `/app/memories/${uid}?h=1&m=${m.id}` : live(m) ? `/app/memories/${uid}?m=${m.id}` : '/app/profile/settings/archive')} aria-label="Open memory"><Thumb m={m} /></button>
            <span className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-1" style={{ display: 'block' }}>{m.highlight_title || m.text_body || (m.kind === 'video' ? 'Video memory' : 'Photo memory')}</span>
              <span className="t-meta" style={{ display: 'block' }}>{timeAgo(m.created_at)} · {m.visibility === 'public' ? 'Public' : 'Friends'} · {m.highlight ? 'Highlight' : live(m) ? 'Live' : 'Expired'}</span></span>
            <button className="btn sm" onClick={() => toggle(m)}>{m.highlight ? 'Unpin' : 'Highlight'}</button>
            <button className="btn sm danger" onClick={() => del(m)} aria-label="Delete memory">Delete</button>
          </li>))}</ul>}
    </>
  )
}
export const HighlightsPage = () => <ArchivePage onlyHighlights />
void authorMemories

/* ------------------------------------------------------------------ view as */
export function ViewAsPage() {
  const { profile } = useAuth()
  const nav = useNavigate()
  if (!profile) return <Spinner />
  return (
    <>
      <Back title="View as" />
      <p className="t-meta" style={{ marginBottom: 12 }}>See your profile the way others see it. Nothing changes; you can leave preview mode at any time.</p>
      <div className="stack" style={{ gap: 8 }}>
        <button className="cp-opt" onClick={() => nav(`/app/u/${profile.username}?as=public`)}><Eye size={22} aria-hidden /><span className="grow"><b>The public</b><span className="t-meta" style={{ display: 'block' }}>Anyone on VYBE who isn’t your friend</span></span></button>
        <button className="cp-opt" onClick={() => nav(`/app/u/${profile.username}?as=friend`)}><Eye size={22} aria-hidden /><span className="grow"><b>A friend</b><span className="t-meta" style={{ display: 'block' }}>Someone you’ve accepted as a friend</span></span></button>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ manage posts */
interface MyPost { id: string; body: string; visibility: 'public' | 'friends' | 'community'; created_at: string; media_path: string | null; media_type: string | null }
export function ManagePosts() {
  const { uid } = useAuth()
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('posts').select('id,body,visibility,created_at,media_path,media_type').eq('author', uid!).order('created_at', { ascending: false }).limit(100)
    if (error) throw error
    return (data ?? []) as MyPost[]
  }, [uid])
  const setVis = async (p: MyPost, v: 'public' | 'friends') => { const { error } = await supabase.from('posts').update({ visibility: v }).eq('id', p.id); if (error) return toast(errMsg(error)); list.reload() }
  const del = async (p: MyPost) => {
    if (!confirm('Delete this post?')) return
    // The gallery's files, with their stills (poster, display copy) where the database has those columns.
    type M = { path: string; poster_path?: string | null; display_path?: string | null }
    const files = (cols: string) => supabase.from('post_media').select(cols).eq('post_id', p.id).returns<M[]>()
    let m = await files('path,poster_path,display_path')
    if (m.error && isMissingSchema(m.error)) m = await files('path')
    const media = m.data ?? []
    const { error } = await supabase.from('posts').delete().eq('id', p.id)
    if (error) return toast(errMsg(error))
    const paths = [...new Set([p.media_path, ...media.flatMap(x => [x.path, x.poster_path, x.display_path])].filter((x): x is string => Boolean(x)))]
    if (paths.length) await supabase.storage.from('media').remove(paths)
    list.reload()
  }
  return (
    <>
      <Back title="Manage posts" />
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? <Empty title="No posts yet" action={<Link className="btn primary" to="/app/create">Create a post</Link>}>Your posts appear here.</Empty> : (
        <ul className="arc">{list.data.map(p => (
          <li key={p.id} className="arc-row" style={{ alignItems: 'flex-start' }}>
            <Link to={`/app/posts/${p.id}`} className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-2" style={{ display: 'block' }}>{p.body || (p.media_type === 'video' ? 'Video' : 'Photo')}</span><span className="t-meta">{timeAgo(p.created_at)}</span></Link>
            {p.visibility === 'community' ? <span className="t-meta">Community</span> : <select className="select" style={{ width: 'auto', minHeight: 36 }} aria-label="Audience" value={p.visibility} onChange={e => setVis(p, e.target.value as 'public' | 'friends')}><option value="public">Public</option><option value="friends">Friends</option></select>}
            <button className="btn sm danger" onClick={() => del(p)}>Delete</button>
          </li>))}</ul>)}
    </>
  )
}

/* ------------------------------------------------------------------ review tags */
export function ReviewTags() {
  const { uid } = useAuth()
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('post_tags').select('post_id,posts!inner(id,body,created_at,profiles:author(id,username,display_name,avatar_path))').eq('user_id', uid!).limit(100)
    if (error) throw error
    return (data ?? []) as unknown as { post_id: string; posts: { id: string; body: string; created_at: string; profiles: { username: string; display_name: string; avatar_path: string | null } } }[]
  }, [uid])
  const remove = async (id: string) => { const { error } = await supabase.from('post_tags').delete().eq('post_id', id).eq('user_id', uid!); if (error) return toast(errMsg(error)); toast('Tag removed'); list.reload() }
  return (
    <>
      <Back title="Review tags" />
      <p className="t-meta" style={{ marginBottom: 12 }}>Friends can tag you in posts. Remove a tag any time; the post itself stays with its author.</p>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? <Empty title="No tags">When a friend tags you, the post shows up here.</Empty> : (
        <ul className="arc">{list.data.map(t => (
          <li key={t.post_id} className="arc-row"><Avatar size="sm" path={t.posts.profiles.avatar_path} name={t.posts.profiles.display_name || t.posts.profiles.username} />
            <Link to={`/app/posts/${t.post_id}`} className="grow" style={{ minWidth: 0 }}><span className="t-name">{t.posts.profiles.display_name || t.posts.profiles.username}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{t.posts.body || 'Photo or video post'}</span></Link>
            <button className="btn sm" onClick={() => remove(t.post_id)}>Remove tag</button></li>))}</ul>)}
    </>
  )
}

/* ------------------------------------------------------------------ privacy center */
export function PrivacyCenter() {
  const { uid, profile, refreshProfile } = useAuth()
  const [dm, setDm] = useState<'friends' | 'everyone'>('friends')
  const [follow, setFollow] = useState<'everyone' | 'friends'>('everyone')
  const [show, setShow] = useState<'public' | 'friends' | 'me'>('public')
  useEffect(() => { if (profile) { setDm(profile.dm_policy); setFollow(profile.follow_policy ?? 'everyone'); setShow(profile.show_followers ?? 'public') } }, [profile])
  const save = async (patch: Record<string, string>) => { const { error } = await supabase.from('profiles').update(patch).eq('id', uid!); if (error) return toast(errMsg(error)); await refreshProfile(); toast('Saved') }
  return (
    <>
      <Back title="Privacy Center" />
      <section className="card" style={{ marginBottom: 12 }}><h2 className="t-section" style={{ marginBottom: 8 }}>Messages and memory replies</h2>
        <Radio name="Who can message you" value={dm} onChange={v => { setDm(v); void save({ dm_policy: v }) }} options={[{ v: 'friends', label: 'Friends only', hint: 'Also decides who can reply to your memories' }, { v: 'everyone', label: 'Anyone' }]} /></section>
      <section className="card" style={{ marginBottom: 12 }}><h2 className="t-section" style={{ marginBottom: 8 }}>Followers</h2>
        <Radio name="Who can follow you" value={follow} onChange={v => { setFollow(v); void save({ follow_policy: v }) }} options={[{ v: 'everyone', label: 'Everyone' }, { v: 'friends', label: 'Friends only' }]} />
        <div style={{ height: 12 }} />
        <Radio name="Who can see your follower counts" value={show} onChange={v => { setShow(v); void save({ show_followers: v }) }} options={[{ v: 'public', label: 'Public' }, { v: 'friends', label: 'Friends' }, { v: 'me', label: 'Only me' }]} /></section>
      <ul className="ps-list">
        <li><Link to="/app/profile/edit" className="ps-row"><Lock size={24} aria-hidden /><span className="grow"><b>Who sees your details</b><span className="t-meta" style={{ display: 'block' }}>Set an audience for each section of your profile</span></span><ChevronRight size={20} aria-hidden /></Link></li>
        <li><Link to="/app/profile/settings/view-as" className="ps-row"><Eye size={24} aria-hidden /><span className="grow"><b>View as</b><span className="t-meta" style={{ display: 'block' }}>Check what others can see</span></span><ChevronRight size={20} aria-hidden /></Link></li>
        <li><Link to="/app/profile/settings/tags" className="ps-row"><Tag size={24} aria-hidden /><span className="grow"><b>Review tags</b></span><ChevronRight size={20} aria-hidden /></Link></li>
        <li><Link to="/app/settings" className="ps-row"><Lock size={24} aria-hidden /><span className="grow"><b>Blocked accounts and data</b><span className="t-meta" style={{ display: 'block' }}>Manage blocks, export or delete your data</span></span><ChevronRight size={20} aria-hidden /></Link></li>
        <li><Link to="/privacy" className="ps-row"><FileText size={24} aria-hidden /><span className="grow"><b>Privacy &amp; safety policy</b></span><ChevronRight size={20} aria-hidden /></Link></li>
      </ul>
    </>
  )
}
void sharePost
