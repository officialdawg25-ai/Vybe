import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Settings2, Share2 } from 'lucide-react'
import { CommunityManage } from '../components/CommunityManage'
import { artStyle, useReadyImage } from '../lib/imgCache'
import { useChromeless } from '../lib/chrome'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { fetchPosts } from '../lib/posts'
import { Composer } from '../components/Composer'
import { Feed } from '../components/Feed'
import { ReportSheet } from '../components/Report'
import { Avatar, Empty, ErrorState, Spinner, Tabs, errMsg, toast, useSigned } from '../ui'
import { formatEventTime } from '../lib/format'
import { isMissingSchema } from '../lib/tickets'
import type { Community, EventRow, Post, PublicProfile } from '../lib/types'

type Tab = 'posts' | 'plans' | 'members' | 'about'
interface Member { user_id: string; role: string; status: string; profiles: PublicProfile }

export default function CommunityDetail() {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const [tab, setTab] = useState<Tab>('posts')
  const [fresh, setFresh] = useState<Post | null>(null)
  const [report, setReport] = useState(false)
  const [busy, submit] = useSubmit()
  const [manage, setManage] = useState(false)
  useChromeless()

  const c = useAsync(async () => {
    // The organisation running it (migration 20) when there is one; older servers return the community alone.
    let { data, error } = await supabase.from('communities').select('*, org:organizations!organization_id(name,slug)').eq('id', id!).maybeSingle()
    if (error && isMissingSchema(error)) ({ data, error } = await supabase.from('communities').select('*').eq('id', id!).maybeSingle())
    if (error) throw error
    return data as Community | null
  }, [id])
  const members = useAsync(async () => {
    const { data, error } = await supabase.from('community_members').select('user_id,role,status,profiles:user_id(id,username,display_name,avatar_path)').eq('community_id', id!).order('created_at').limit(300)
    if (error) throw error
    return (data ?? []) as unknown as Member[]
  }, [id])
  useEffect(() => { document.title = c.data ? `${c.data.name} · VYBE` : 'Community · VYBE' }, [c.data])
  const coverSigned = useSigned(c.data?.cover_path), picSigned = useSigned(c.data?.avatar_path ?? null)
  const coverOk = useReadyImage(coverSigned), picOk = useReadyImage(picSigned)

  if (c.loading) return <Spinner />
  if (c.error) return <ErrorState message={c.error} onRetry={c.reload} />
  const com = c.data
  if (!com) return <Empty title="Community not found">It may have been removed.</Empty>
  const me = members.data?.find(m => m.user_id === uid)
  const active = me?.status === 'active'
  const canMod = active && ['owner', 'admin', 'moderator'].includes(me!.role)
  const canAdmin = active && ['owner', 'admin'].includes(me!.role)
  const locked = com.visibility === 'private' && !active

  const join = () => submit(async () => {
    const { error } = await supabase.from('community_members').insert({ community_id: com.id, user_id: uid, role: 'member', status: com.visibility === 'public' ? 'active' : 'pending' })
    if (error) return toast(errMsg(error))
    toast(com.visibility === 'public' ? 'Joined' : 'Request sent'); members.reload()
  })
  const leave = () => submit(async () => {
    if (!confirm(active ? 'Leave this community?' : 'Cancel your request?')) return
    const { error } = await supabase.from('community_members').delete().eq('community_id', com.id).eq('user_id', uid!)
    if (error) return toast(errMsg(error)); members.reload()
  })
  const setMember = async (m: Member, patch: { status?: string; role?: string }) => {
    const { error } = await supabase.from('community_members').update(patch).eq('community_id', com.id).eq('user_id', m.user_id)
    if (error) toast(errMsg(error)); else members.reload()
  }
  const removeMember = async (m: Member) => {
    if (!confirm('Remove this member?')) return
    const { error } = await supabase.from('community_members').delete().eq('community_id', com.id).eq('user_id', m.user_id)
    if (error) toast(errMsg(error)); else members.reload()
  }
  const share = async () => { const url = `${window.location.origin}/app/communities/${com.id}`; if (navigator.share) { try { await navigator.share({ url, title: com.name }) } catch { /* dismissed */ } } else { await navigator.clipboard.writeText(url); toast('Community link copied') } }
  const activeCount = members.data?.filter(m => m.status === 'active').length ?? 0
  const requests = canMod ? members.data?.filter(m => m.status === 'pending').length ?? 0 : 0
  const del = async () => { if (confirm('Delete this community and all its posts?')) { const { error } = await supabase.from('communities').delete().eq('id', com.id); if (error) toast(errMsg(error)); else nav('/app/communities', { replace: true }) } }

  return (
    <>
      <div className="cm">
        <div className={`pf-hero cm-hero${coverOk ? ' has-cover' : ''}`}>
          <div className="pf-hero-img" style={artStyle(coverSigned, coverOk)} aria-hidden />
          <div className="pf-hero-shade" aria-hidden />
          <header className="pf-bar">
            <button className="pf-ibtn" aria-label="Back" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/app/communities'))}><ChevronLeft size={24} /></button>
            <span className="grow" />
            <button className="pf-ibtn" aria-label="Share community" onClick={share}><Share2 size={20} /></button>
            {canAdmin && <button className="pf-ibtn" aria-label="Manage community" onClick={() => setManage(true)}><Settings2 size={22} /></button>}
          </header>
        </div>
        <section className="cm-card" aria-label="Community">
          <span className="cm-av" style={artStyle(picSigned, picOk)} aria-hidden>{!picOk && com.name.charAt(0).toUpperCase()}</span>
          <h1 className="pf-name">{com.name}</h1>
          <p className="pf-handle">{com.visibility === 'private' ? 'Private community' : 'Public community'} · {activeCount} {activeCount === 1 ? 'member' : 'members'}{com.org ? <> · Run by <Link to={`/app/pages/${com.org.slug}`}>{com.org.name}</Link></> : null}</p>
          {com.description && <p className="pf-bio">{com.description}</p>}
          {com.topics.length > 0 && <div className="chips" style={{ justifyContent: 'center' }}>{com.topics.map(t => <span key={t} className="chip on" style={{ cursor: 'default' }}>{t}</span>)}</div>}
          <div className="pf-actions">
            {!me ? <button className="btn primary pf-main" disabled={busy} onClick={join}>{com.visibility === 'public' ? 'Join' : 'Request to join'}</button>
              : me.status === 'pending' ? <button className="btn pf-main" disabled={busy} onClick={leave}>Requested · Cancel</button>
              : me.role !== 'owner' ? <button className="btn pf-main" disabled={busy} onClick={leave}>Joined · Leave</button> : <button className="btn primary pf-main" onClick={() => setManage(true)}><Settings2 size={16} aria-hidden /> Manage</button>}
            <button className="btn pf-icon" aria-label="Share community" onClick={share}><Share2 size={18} /></button>
            {!active && <button className="btn ghost sm" onClick={() => setReport(true)}>Report</button>}
            {me?.role === 'owner' && <button className="btn ghost sm danger" onClick={del}>Delete</button>}
          </div>
          {requests > 0 && <button className="cm-req" onClick={() => setTab('members')}>{requests} {requests === 1 ? 'person wants' : 'people want'} to join · Review</button>}
        </section>
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'posts', label: 'Posts' }, { id: 'plans', label: 'Plans' }, { id: 'members', label: canMod && members.data?.some(m => m.status === 'pending') ? 'Members •' : 'Members' }, { id: 'about', label: 'About' }]} />
      {locked && tab !== 'about' && tab !== 'members' ? <Empty title="This community is private">Request to join to see its posts and plans.</Empty>
        : tab === 'posts' ? <>
          {active && (com.post_policy !== 'admins' || canMod) && <Composer communityId={com.id} onPosted={setFresh} />}
          {active && com.post_policy === 'admins' && !canMod && <p className="notice" role="status">Only this community’s admins can post here. You can read and comment.</p>}
          <Feed load={cur => fetchPosts({ uid: uid!, cursor: cur, communityId: com.id })} deps={[com.id]} prepend={fresh} empty={{ title: 'No posts yet', text: active ? 'Start the conversation.' : 'Join to post.' }} />
        </>
        : tab === 'plans' ? <CommunityPlans id={com.id} canCreate={active} />
        : tab === 'about' ? <div className="stack"><section><h2 className="t-section">Rules</h2><p style={{ whiteSpace: 'pre-wrap' }} className="t-support">{com.rules || 'No rules have been set.'}</p></section></div>
        : members.loading ? <Spinner /> : (
          <div className="list">{members.data?.filter(m => m.status === 'active' || canMod).map(m => (
            <div key={m.user_id} className="item row">
              <Link to={`/app/u/${m.profiles.username}`}><Avatar size="sm" path={m.profiles.avatar_path} name={m.profiles.display_name || m.profiles.username} /></Link>
              <div className="grow"><div className="t-name clamp-1">{m.profiles.display_name || m.profiles.username}</div><div className="t-meta">{m.status === 'pending' ? 'Wants to join' : m.role}</div></div>
              {canMod && m.role !== 'owner' && m.user_id !== uid && (
                <span className="row" style={{ gap: 6 }}>
                  {m.status === 'pending' && <button className="btn primary sm" onClick={() => setMember(m, { status: 'active' })}>Approve</button>}
                  {canAdmin && m.status === 'active' && <select className="select" style={{ minHeight: 36, width: 'auto' }} aria-label="Role" value={m.role} onChange={e => setMember(m, { role: e.target.value })}><option value="member">member</option><option value="moderator">moderator</option><option value="admin">admin</option></select>}
                  <button className="btn sm danger" onClick={() => removeMember(m)}>{m.status === 'pending' ? 'Decline' : 'Remove'}</button>
                </span>
              )}
            </div>))}</div>
        )}
      {manage && <CommunityManage c={com} uid={uid!} onClose={() => setManage(false)} onSaved={() => c.reload()} />}
      {report && <ReportSheet target={{ type: 'community', id: com.id }} onClose={() => setReport(false)} />}
    </>
  )
}

function CommunityPlans({ id, canCreate }: { id: string; canCreate: boolean }) {
  const nav = useNavigate()
  const { data, loading, error, reload } = useAsync(async () => {
    const { data, error } = await supabase.from('events').select('*').eq('community_id', id).eq('status', 'active').gte('starts_at', new Date().toISOString()).order('starts_at').limit(30)
    if (error) throw error
    return (data ?? []) as EventRow[]
  }, [id])
  if (loading) return <Spinner />
  if (error) return <ErrorState message={error} onRetry={reload} />
  return (
    <>
      {canCreate && <button className="btn sm" style={{ marginBottom: 8 }} onClick={() => nav('/app/plans?new=1')}>Create a plan</button>}
      {!data?.length ? <Empty title="No upcoming plans">Plans created in this community will show up here.</Empty> : (
        <div className="list">{data.map(e => <Link key={e.id} to={`/app/plans/${e.id}`} className="item link" style={{ display: 'block' }}><div className="t-meta" style={{ color: 'var(--brand)', fontWeight: 600 }}>{formatEventTime(e.starts_at, e.timezone)}</div><div className="t-name">{e.title}</div></Link>)}</div>
      )}
    </>
  )
}
