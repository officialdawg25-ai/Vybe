import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { fetchPosts } from '../lib/posts'
import { Composer } from '../components/Composer'
import { Feed } from '../components/Feed'
import { ReportSheet } from '../components/Report'
import { Avatar, Empty, ErrorState, Spinner, Tabs, errMsg, toast } from '../ui'
import { formatEventTime } from '../lib/format'
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

  const c = useAsync(async () => {
    const { data, error } = await supabase.from('communities').select('*').eq('id', id!).maybeSingle()
    if (error) throw error
    return data as Community | null
  }, [id])
  const members = useAsync(async () => {
    const { data, error } = await supabase.from('community_members').select('user_id,role,status,profiles:user_id(id,username,display_name,avatar_path)').eq('community_id', id!).order('created_at').limit(300)
    if (error) throw error
    return (data ?? []) as unknown as Member[]
  }, [id])
  useEffect(() => { document.title = c.data ? `${c.data.name} · VYBE` : 'Community · VYBE' }, [c.data])

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
  const del = async () => { if (confirm('Delete this community and all its posts?')) { const { error } = await supabase.from('communities').delete().eq('id', com.id); if (error) toast(errMsg(error)); else nav('/app/communities', { replace: true }) } }

  return (
    <>
      <header className="stack" style={{ gap: 8, marginBottom: 12 }}>
        <div><h1 className="t-title">{com.name}</h1><p className="t-meta">{com.visibility === 'private' ? 'Private community' : 'Public community'} · {members.data?.filter(m => m.status === 'active').length ?? 0} members</p></div>
        {com.description && <p style={{ whiteSpace: 'pre-wrap' }}>{com.description}</p>}
        {com.topics.length > 0 && <div className="chips">{com.topics.map(t => <span key={t} className="chip on" style={{ cursor: 'default' }}>{t}</span>)}</div>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {!me ? <button className="btn primary sm" disabled={busy} onClick={join}>{com.visibility === 'public' ? 'Join' : 'Request to join'}</button>
            : me.status === 'pending' ? <button className="btn sm" disabled={busy} onClick={leave}>Requested · Cancel</button>
            : me.role !== 'owner' && <button className="btn sm" disabled={busy} onClick={leave}>Leave</button>}
          {!active && <button className="btn ghost sm" onClick={() => setReport(true)}>Report</button>}
          {me?.role === 'owner' && <button className="btn ghost sm danger" onClick={del}>Delete community</button>}
        </div>
      </header>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'posts', label: 'Posts' }, { id: 'plans', label: 'Plans' }, { id: 'members', label: canMod && members.data?.some(m => m.status === 'pending') ? 'Members •' : 'Members' }, { id: 'about', label: 'About' }]} />
      {locked && tab !== 'about' && tab !== 'members' ? <Empty title="This community is private">Request to join to see its posts and plans.</Empty>
        : tab === 'posts' ? <>
          {active && <Composer communityId={com.id} onPosted={setFresh} />}
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
