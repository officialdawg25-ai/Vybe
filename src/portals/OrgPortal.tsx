import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Empty, ErrorState, Field, Spinner, Tabs, errMsg, toast } from '../ui'
import { PlanForm } from '../components/PlanForm'
import { formatEventTime } from '../lib/format'
import { Composer } from '../components/Composer'
import { Feed } from '../components/Feed'
import { fetchPosts } from '../lib/posts'
import { DoorScanner } from '../components/tickets/DoorScanner'
import { FinancePanel } from '../components/FinancePanel'
import { RefundQueue } from '../components/RefundQueue'
import { OrgCampaigns } from '../components/OrgCampaigns'
import { OrgHistory, OrgNotifPrefs, OrgOverview } from '../components/OrgOverview'
import { OrgCommunities } from '../components/OrgCommunities'
import { MediaLibrary } from '../components/MediaLibrary'
import { OrgIdentity, type OrgIdentityRow } from '../components/OrgIdentity'
import { isMissingSchema } from '../lib/tickets'
import type { Post } from '../lib/types'
import type { EventRow } from '../lib/types'
import { PortalShell } from './PortalShell'
import OrgList from '../pages/Organizations'

interface Org extends OrgIdentityRow { kind: string; verified_at: string | null }
const BASE = 'id,name,slug,kind,description,verified_at,avatar_path'

/** /org — for people who run organizations (organizers, venues, brands). Separate from the user portal and the admin portal. */
export function OrgPortal() {
  useEffect(() => { document.title = 'Organizations · VYBE' }, [])
  return <PortalShell kind="org" label="Organizations" nav={[{ to: '/org', label: 'My organizations', end: true }]} />
}

export { OrgList }

/** /org/:slug — dashboard for one organization. Access is by active membership (RLS decides what is returned). */
export function OrgDashboard() {
  const { slug } = useParams()
  const { uid } = useAuth()
  const [params, setParams] = useSearchParams()
  type Tab = 'overview' | 'events' | 'posts' | 'communities' | 'media' | 'checkin' | 'campaigns' | 'finance' | 'members' | 'settings'
  const tab = (['overview', 'events', 'posts', 'communities', 'media', 'checkin', 'campaigns', 'finance', 'members', 'settings'].includes(params.get('tab') ?? '') ? params.get('tab') : 'overview') as Tab
  const org = useAsync(async () => {
    // Cover, website, links and location arrive with migration 19; until then the portal works with the original columns.
    let identity = true
    let r = await supabase.from('organizations').select(`${BASE},cover_path,website,links,location`).ilike('slug', slug ?? '').maybeSingle()
    if (r.error && isMissingSchema(r.error)) { identity = false; r = await supabase.from('organizations').select(BASE).ilike('slug', slug ?? '').maybeSingle() }
    if (r.error) throw r.error
    if (!r.data) return null
    const data = { cover_path: null, website: null, links: [], location: null, ...(r.data as unknown as Partial<Org>) } as Org
    const { data: m, error: e2 } = await supabase.from('organization_members').select('role,status').eq('organization_id', data.id).eq('user_id', uid!).maybeSingle()
    if (e2) throw e2
    return { org: data, identity, role: m?.status === 'active' ? (m.role as string) : null }
  }, [slug, uid])

  if (org.loading) return <Spinner />
  if (org.error) return <ErrorState message={org.error} onRetry={org.reload} />
  if (!org.data) return <Empty title="Organization not found" action={<Link className="btn" to="/org">Back to my organizations</Link>}>It may have been removed, or the handle is wrong.</Empty>
  if (!org.data.role) return <Empty title="You’re not a member" action={<Link className="btn" to="/org">Back to my organizations</Link>}>Only active members can open an organization’s dashboard.</Empty>
  const { org: o, role, identity } = org.data
  const manage = role === 'owner' || role === 'admin'
  return (
    <>
      <div className="row between" style={{ marginBottom: 4 }}>
        <h1 className="t-title">{o.name}</h1>
        <span className="t-meta">@{o.slug} · {o.kind} · you are {role}{o.verified_at ? ' · Verified' : ''}</span>
      </div>
      {o.description && <p className="t-support" style={{ marginBottom: 12 }}>{o.description}</p>}
      <Tabs value={tab} onChange={t => setParams({ tab: t }, { replace: true })}
        items={[{ id: 'overview', label: 'Overview' }, { id: 'events', label: 'Events' }, { id: 'posts', label: 'Page posts' }, { id: 'communities', label: 'Communities' }, { id: 'media', label: 'Media' }, { id: 'checkin', label: 'Check-in' }, ...(manage ? [{ id: 'campaigns' as const, label: 'Campaigns' }, { id: 'finance' as const, label: 'Finance' }] : []), { id: 'members', label: 'Members' }, ...(manage ? [{ id: 'settings' as const, label: 'Settings' }] : [])]} />
      {tab === 'overview' && <OrgOverview orgId={o.id} slug={o.slug} />}
      {tab === 'events' && <OrgEvents org={o} />}
      {tab === 'posts' && <OrgPosts org={o} />}
      {tab === 'communities' && <OrgCommunities orgId={o.id} orgName={o.name} manage={manage} />}
      {tab === 'media' && <MediaLibrary orgId={o.id} canManage={manage} />}
      {tab === 'checkin' && <OrgCheckIn org={o} />}
      {tab === 'campaigns' && manage && <OrgCampaigns orgId={o.id} orgName={o.name} />}
      {tab === 'finance' && manage && <><FinancePanel orgId={o.id} /><h2 className="t-section" style={{ margin: '24px 0 8px' }}>Refund requests</h2><RefundQueue orgId={o.id} /></>}
      {tab === 'members' && <>
        <OrgMembers org={o} manage={manage} owner={role === 'owner'} />
        <div style={{ marginTop: 24 }}><OrgNotifPrefs orgId={o.id} role={role} /></div>
      </>}
      {tab === 'settings' && manage && <>
        <OrgIdentity key={`${o.avatar_path}|${o.cover_path}`} org={o} identity={identity} onSaved={org.reload} />
        <h2 className="t-section" style={{ margin: '28px 0 8px' }}>History</h2>
        <OrgHistory orgId={o.id} />
      </>}
      {tab === 'settings' && !manage && <Navigate to={`/org/${o.slug}`} replace />}
    </>
  )
}

function OrgEvents({ org }: { org: Org }) {
  const [creating, setCreating] = useState(false)
  const events = useAsync(async () => {
    const { data, error } = await supabase.from('events').select('*').eq('organization_id', org.id).order('starts_at', { ascending: false }).limit(50)
    if (error) throw error
    return (data ?? []) as EventRow[]
  }, [org.id])
  if (creating) return <PlanForm organizationId={org.id} onSaved={() => { setCreating(false); events.reload(); toast('Event created') }} onCancel={() => setCreating(false)} />
  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}><h2 className="t-section">Hosted events</h2><button className="btn primary sm" onClick={() => setCreating(true)}>New event</button></div>
      {events.loading ? <Spinner /> : events.error ? <ErrorState message={events.error} onRetry={events.reload} /> : !events.data?.length
        ? <Empty title="No events yet" action={<button className="btn primary" onClick={() => setCreating(true)}>Create your first event</button>}>Events you host as {org.name} appear here and on Discover when public.</Empty>
        : <div className="list">{events.data.map(e => (
            <Link key={e.id} to={`/app/plans/${e.id}`} className="item link" style={{ display: 'block' }}>
              <div className="t-name">{e.title}{e.status === 'cancelled' && <span className="t-meta"> · Cancelled</span>}</div>
              <div className="t-meta">{formatEventTime(e.starts_at, e.timezone)}{e.location ? ` · ${e.location}` : ''} · {e.visibility}</div>
            </Link>))}</div>}
    </>
  )
}

interface Member { user_id: string; role: string; status: string; profiles: { username: string; display_name: string } }

function OrgMembers({ org, manage, owner }: { org: Org; manage: boolean; owner: boolean }) {
  const { uid } = useAuth()
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<'admin' | 'editor'>('editor')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const members = useAsync(async () => {
    const { data, error } = await supabase.from('organization_members').select('user_id,role,status,profiles(username,display_name)').eq('organization_id', org.id)
    if (error) throw error
    return (data ?? []) as unknown as Member[]
  }, [org.id])
  const invite = () => submit(async () => {
    setErr('')
    const u = username.trim().toLowerCase().replace(/^@/, '')
    if (!u) return setErr('Enter a username.')
    const { data: p, error: e1 } = await supabase.from('profiles').select('id').eq('username', u).maybeSingle()
    if (e1) return setErr(errMsg(e1))
    if (!p) return setErr('No one on VYBE has that username.')
    const { error } = await supabase.from('organization_members').insert({ organization_id: org.id, user_id: p.id, role, status: 'invited' })
    if (error) return setErr(error.code === '23505' ? 'They are already invited or a member.' : errMsg(error))
    setUsername(''); toast('Invitation sent'); members.reload()
  })
  // Owners only; the server re-checks (set_org_member_role) and records the change in the organisation's history.
  const setMemberRole = async (m: Member, next: string) => {
    const { error } = await supabase.rpc('set_org_member_role', { p_org: org.id, p_user: m.user_id, p_role: next })
    if (error) toast(error.code === 'PGRST202' ? 'Changing roles needs the latest database update.' : errMsg(error)); else { toast(`@${m.profiles.username} is now ${next === 'admin' ? 'an admin' : 'an editor'}`); members.reload() }
  }
  const remove = async (m: Member) => {
    if (!confirm(`Remove @${m.profiles.username} from ${org.name}?`)) return
    const { error } = await supabase.from('organization_members').delete().eq('organization_id', org.id).eq('user_id', m.user_id)
    if (error) toast(errMsg(error)); else members.reload()
  }
  return (
    <>
      {manage && (
        <section aria-label="Invite a member" style={{ marginBottom: 20 }}>
          <h2 className="t-section" style={{ marginBottom: 8 }}>Invite someone</h2>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="grow" style={{ minWidth: 160 }}><Field id="m-user" label="Username"><input id="m-user" className="input" value={username} autoCapitalize="none" onChange={e => setUsername(e.target.value)} /></Field></div>
            <Field id="m-role" label="Role"><select id="m-role" className="select" value={role} onChange={e => setRole(e.target.value as 'admin' | 'editor')}><option value="editor">Editor</option><option value="admin">Admin</option></select></Field>
            <button className="btn primary" style={{ marginBottom: 16 }} disabled={busy} onClick={invite}>Send invite</button>
          </div>
          <p className="t-meta">Editors can host events. Admins can also manage members and settings. Membership never exposes anyone’s private account data.</p>
          {err && <p className="error" role="alert">{err}</p>}
        </section>
      )}
      <h2 className="t-section" style={{ marginBottom: 4 }}>Members</h2>
      {members.loading ? <Spinner /> : members.error ? <ErrorState message={members.error} onRetry={members.reload} /> : (
        <div className="list">{members.data?.map(m => (
          <div key={m.user_id} className="item row">
            <div className="grow"><div className="t-name">{m.profiles?.display_name || m.profiles?.username}</div><div className="t-meta">@{m.profiles?.username} · {m.role}{m.status === 'invited' ? ' · Invited' : ''}</div></div>
            {owner && m.role !== 'owner' && m.user_id !== uid && m.status === 'active' && (
              <select className="select" style={{ width: 'auto', minHeight: 36 }} aria-label={`Role for @${m.profiles?.username}`} value={m.role} onChange={e => void setMemberRole(m, e.target.value)}>
                <option value="editor">Editor</option><option value="admin">Admin</option>
              </select>
            )}
            {(manage && m.role !== 'owner' && m.user_id !== uid) && <button className="btn sm danger" onClick={() => remove(m)}>{m.status === 'invited' ? 'Cancel invite' : 'Remove'}</button>}
          </div>))}</div>
      )}
    </>
  )
}

/** Posts published as the organization (its "page"). Anyone on VYBE can see them in Home; only editors can publish. */
function OrgPosts({ org }: { org: Org }) {
  const { uid } = useAuth()
  const [fresh, setFresh] = useState<Post | null>(null)
  const load = useMemo(() => (cursor?: string) => fetchPosts({ uid: uid!, cursor, organizationId: org.id }), [uid, org.id])
  return (
    <>
      <p className="t-meta" style={{ marginBottom: 8 }}>Posts here appear as <b>{org.name}</b> and are always public.</p>
      <Composer organizationId={org.id} placeholder={`Post as ${org.name}`} onPosted={setFresh} />
      <Feed load={load} deps={[org.id]} prepend={fresh} empty={{ title: 'No page posts yet', text: 'Announce a lineup, a ticket release or a recap.' }} />
    </>
  )
}

/** Door check-in: choose the event, then type or scan. The scanner itself is shared with door staff (/app/scan/:event). */
function OrgCheckIn({ org }: { org: Org }) {
  const [eventId, setEventId] = useState('')
  const events = useAsync(async () => {
    const { data, error } = await supabase.from('events').select('id,title,starts_at,timezone').eq('organization_id', org.id).eq('status', 'active').order('starts_at', { ascending: false }).limit(30)
    if (error) throw error
    return (data ?? []) as Pick<EventRow, 'id' | 'title' | 'starts_at' | 'timezone'>[]
  }, [org.id])
  return (
    <>
      <Field id="ci-ev" label="Event"><select id="ci-ev" className="select" value={eventId} onChange={e => setEventId(e.target.value)}>
        <option value="">Choose the event at the door</option>{events.data?.map(e => <option key={e.id} value={e.id}>{e.title} · {formatEventTime(e.starts_at, e.timezone)}</option>)}</select></Field>
      {eventId ? <DoorScanner key={eventId} eventId={eventId} /> : <p className="t-support">Tickets are checked against one event, so a ticket for another night is refused at the door.</p>}
      {eventId && <p className="t-meta" style={{ marginTop: 12 }}>Door staff who are not members of {org.name} can scan too: add them on the event page under <b>Ticket sales &amp; door</b>.</p>}
    </>
  )
}
