import { useEffect, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Empty, ErrorState, Field, Spinner, Tabs, errMsg, toast } from '../ui'
import { PlanForm } from '../components/PlanForm'
import { formatEventTime } from '../lib/format'
import type { EventRow } from '../lib/types'
import { PortalShell } from './PortalShell'
import OrgList from '../pages/Organizations'

interface Org { id: string; name: string; slug: string; kind: string; description: string; verified_at: string | null }

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
  const tab = (['events', 'members', 'settings'].includes(params.get('tab') ?? '') ? params.get('tab') : 'events') as 'events' | 'members' | 'settings'
  const org = useAsync(async () => {
    const { data, error } = await supabase.from('organizations').select('id,name,slug,kind,description,verified_at').ilike('slug', slug ?? '').maybeSingle()
    if (error) throw error
    if (!data) return null
    const { data: m, error: e2 } = await supabase.from('organization_members').select('role,status').eq('organization_id', data.id).eq('user_id', uid!).maybeSingle()
    if (e2) throw e2
    return { org: data as Org, role: m?.status === 'active' ? (m.role as string) : null }
  }, [slug, uid])

  if (org.loading) return <Spinner />
  if (org.error) return <ErrorState message={org.error} onRetry={org.reload} />
  if (!org.data) return <Empty title="Organization not found" action={<Link className="btn" to="/org">Back to my organizations</Link>}>It may have been removed, or the handle is wrong.</Empty>
  if (!org.data.role) return <Empty title="You’re not a member" action={<Link className="btn" to="/org">Back to my organizations</Link>}>Only active members can open an organization’s dashboard.</Empty>
  const { org: o, role } = org.data
  const manage = role === 'owner' || role === 'admin'
  return (
    <>
      <div className="row between" style={{ marginBottom: 4 }}>
        <h1 className="t-title">{o.name}</h1>
        <span className="t-meta">@{o.slug} · {o.kind} · you are {role}{o.verified_at ? ' · Verified' : ''}</span>
      </div>
      {o.description && <p className="t-support" style={{ marginBottom: 12 }}>{o.description}</p>}
      <Tabs value={tab} onChange={t => setParams({ tab: t }, { replace: true })}
        items={[{ id: 'events', label: 'Events' }, { id: 'members', label: 'Members' }, ...(manage ? [{ id: 'settings' as const, label: 'Settings' }] : [])]} />
      {tab === 'events' && <OrgEvents org={o} />}
      {tab === 'members' && <OrgMembers org={o} manage={manage} />}
      {tab === 'settings' && manage && <OrgSettings org={o} onSaved={org.reload} />}
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

function OrgMembers({ org, manage }: { org: Org; manage: boolean }) {
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
            {(manage && m.role !== 'owner' && m.user_id !== uid) && <button className="btn sm danger" onClick={() => remove(m)}>{m.status === 'invited' ? 'Cancel invite' : 'Remove'}</button>}
          </div>))}</div>
      )}
    </>
  )
}

function OrgSettings({ org, onSaved }: { org: Org; onSaved: () => void }) {
  const [name, setName] = useState(org.name)
  const [description, setDescription] = useState(org.description)
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const save = () => submit(async () => {
    if (name.trim().length < 2) return setErr('Enter a name.')
    const { error } = await supabase.from('organizations').update({ name: name.trim(), description: description.trim() }).eq('id', org.id)
    if (error) return setErr(errMsg(error))
    setErr(''); toast('Saved'); onSaved()
  })
  return (
    <section aria-label="Organization settings">
      <Field id="s-name" label="Name"><input id="s-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
      <Field id="s-desc" label="About"><textarea id="s-desc" className="textarea" value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></Field>
      <p className="t-meta" style={{ marginBottom: 12 }}>The handle (@{org.slug}) and verification are fixed and can’t be changed here.</p>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary" disabled={busy} onClick={save}>Save changes</button>
    </section>
  )
}
