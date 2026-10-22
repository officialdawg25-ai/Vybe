import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import { useAsync, useSubmit } from '../lib/hooks'
import { isMissingSchema } from '../lib/tickets'
import { Empty, ErrorState, Field, Spinner, errMsg, toast } from '../ui'

interface Row { id: string; name: string; description: string; visibility: 'public' | 'private'; organization_id: string | null; community_members: { count: number }[] }

/**
 * Communities the organisation runs. Owners and admins create them as the organisation, or bring in a community they own;
 * the organisation's owners and admins then moderate it like community admins (enforced in the database, migration 20).
 */
export function OrgCommunities({ orgId, orgName, manage }: { orgId: string; orgName: string; manage: boolean }) {
  const { uid } = useAuth()
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('communities').select('id,name,description,visibility,organization_id,community_members(count)').eq('organization_id', orgId).order('created_at', { ascending: false })
    if (error) { if (isMissingSchema(error)) return null; throw error }
    return (data ?? []) as unknown as Row[]
  }, [orgId])
  // Communities the member owns personally and could bring into the organisation.
  const mine = useAsync(async () => {
    if (!manage) return [] as Row[]
    const { data, error } = await supabase.from('community_members').select('communities!inner(id,name,description,visibility,organization_id)').eq('user_id', uid!).eq('role', 'owner').eq('status', 'active')
    if (error) return [] as Row[]
    return ((data ?? []) as unknown as { communities: Row }[]).map(r => r.communities).filter(c => !c.organization_id)
  }, [uid, manage, list.data])

  const create = () => submit(async () => {
    setErr('')
    if (name.trim().length < 2) return setErr('Enter a name (at least 2 characters).')
    const { error } = await supabase.from('communities').insert({ name: name.trim(), description: about.trim(), visibility, created_by: uid, organization_id: orgId })
    if (error) return setErr(errMsg(error))
    setName(''); setAbout(''); toast(`Created as ${orgName}`); list.reload()
  })
  const move = (id: string, to: string | null) => submit(async () => {
    const { error } = await supabase.rpc('set_community_organization', { p_community: id, p_org: to })
    if (error) return toast(errMsg(error))
    toast(to ? `Now run by ${orgName}` : 'No longer run by the organisation'); list.reload(); mine.reload()
  })

  if (list.loading && !list.data) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (list.data === null) return <p className="notice" role="status">Organisation communities need the latest database update.</p>
  return (
    <section aria-label="Communities">
      {manage && (
        <details className="card" style={{ padding: 16, marginBottom: 16 }}>
          <summary className="t-name">Create a community as {orgName}</summary>
          <Field id="oc-name" label="Name"><input id="oc-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
          <Field id="oc-about" label="About"><textarea id="oc-about" className="textarea" value={about} maxLength={1000} onChange={e => setAbout(e.target.value)} /></Field>
          <Field id="oc-vis" label="Who can find it"><select id="oc-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value as 'public' | 'private')}><option value="public">Public: anyone can find and join</option><option value="private">Private: invite only</option></select></Field>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn primary" disabled={busy} onClick={create}>Create community</button>
        </details>
      )}
      {!list.data.length ? (
        <Empty title="No communities yet">{manage ? 'Create one for your fans, regulars or crew, or bring in a community you already run.' : 'The organisation’s owners and admins can create communities here.'}</Empty>
      ) : (
        <ul className="list" aria-label={`Communities run by ${orgName}`}>
          {list.data.map(c => (
            <li key={c.id} className="item row">
              <div className="grow" style={{ minWidth: 0 }}>
                <Link to={`/app/communities/${c.id}`} className="t-name">{c.name}</Link>
                <div className="t-meta clamp-1">{c.visibility === 'private' ? 'Private' : 'Public'} · {c.community_members?.[0]?.count ?? 0} members{c.description ? ` · ${c.description}` : ''}</div>
              </div>
              {manage && <button className="btn sm ghost" disabled={busy} onClick={() => { if (confirm(`Stop running “${c.name}” as ${orgName}? Its creator keeps it.`)) move(c.id, null) }}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {manage && (mine.data?.length ?? 0) > 0 && (
        <>
          <h2 className="t-section" style={{ margin: '20px 0 8px' }}>Bring in a community you own</h2>
          <ul className="list">{mine.data!.map(c => (
            <li key={c.id} className="item row"><span className="grow t-name">{c.name}</span><button className="btn sm" disabled={busy} onClick={() => move(c.id, orgId)}>Run as {orgName}</button></li>
          ))}</ul>
        </>
      )}
    </section>
  )
}
