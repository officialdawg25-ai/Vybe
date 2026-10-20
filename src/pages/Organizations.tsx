import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Empty, ErrorState, Field, Spinner, errMsg, toast } from '../ui'

interface Org { id: string; name: string; slug: string; kind: string; description: string; verified_at: string | null }
interface Membership { organization_id: string; role: string; status: string; organizations: Org }
const KINDS = ['artist', 'organizer', 'venue', 'business', 'creator', 'brand']

export default function Organizations() {
  const { uid } = useAuth()
  const [form, setForm] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [kind, setKind] = useState('organizer')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  useEffect(() => { document.title = 'Organizations · VYBE' }, [])
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('organization_members').select('organization_id,role,status,organizations(id,name,slug,kind,description,verified_at)').eq('user_id', uid!)
    if (error) throw error
    return (data ?? []) as unknown as Membership[]
  }, [uid])

  const create = () => submit(async () => {
    const s = slug.trim().toLowerCase()
    if (name.trim().length < 2) return setErr('Enter a name.')
    if (!/^[a-z0-9-]{3,40}$/.test(s)) return setErr('Handle must be 3–40 characters: letters, numbers or hyphens.')
    const { error } = await supabase.from('organizations').insert({ name: name.trim(), slug: s, kind, description: description.trim(), created_by: uid })
    if (error) return setErr(error.code === '23505' ? 'That handle is taken.' : errMsg(error))
    setForm(false); setName(''); setSlug(''); setDescription(''); setErr(''); list.reload()
  })
  const accept = async (id: string) => { const { error } = await supabase.from('organization_members').update({ status: 'active' }).eq('organization_id', id).eq('user_id', uid!); if (error) toast(errMsg(error)); else list.reload() }
  const decline = async (id: string) => { const { error } = await supabase.from('organization_members').delete().eq('organization_id', id).eq('user_id', uid!); if (error) toast(errMsg(error)); else list.reload() }

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}><h1 className="t-title">Organizations</h1><button className="btn primary sm" onClick={() => setForm(f => !f)}>{form ? 'Close' : 'New organization'}</button></div>
      <p className="t-support" style={{ marginBottom: 16 }}>Run plans and streams as an organizer, venue or brand. Organizations are separate from your personal profile, and membership never gives access to anyone's private account data.</p>
      {form && (
        <section style={{ marginBottom: 24 }} aria-label="Create organization">
          <Field id="o-name" label="Name"><input id="o-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
          <Field id="o-slug" label="Handle" hint="Letters, numbers and hyphens."><input id="o-slug" className="input" value={slug} maxLength={40} autoCapitalize="none" onChange={e => setSlug(e.target.value)} /></Field>
          <Field id="o-kind" label="Type"><select id="o-kind" className="select" value={kind} onChange={e => setKind(e.target.value)}>{KINDS.map(k => <option key={k} value={k}>{k}</option>)}</select></Field>
          <Field id="o-desc" label="About"><textarea id="o-desc" className="textarea" value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></Field>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn primary" disabled={busy} onClick={create}>Create organization</button>
        </section>
      )}
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? <Empty title="No organizations yet">Create one to host plans as a group or business.</Empty> : (
        <div className="list">{list.data.map(m => (
          <div key={m.organization_id} className="item">
            <div className="t-name">{m.status === 'active' ? <Link to={`/org/${m.organizations.slug}`} style={{ textDecoration: 'underline' }}>{m.organizations.name}</Link> : m.organizations.name} <span className="t-meta">@{m.organizations.slug} · {m.organizations.kind} · {m.role}{m.organizations.verified_at ? ' · Verified' : ''}</span></div>
            {m.organizations.description && <p className="t-support">{m.organizations.description}</p>}
            {m.status === 'invited' && <div className="row" style={{ marginTop: 6 }}><span className="t-meta">You've been invited to join.</span><button className="btn primary sm" onClick={() => accept(m.organization_id)}>Accept</button><button className="btn sm" onClick={() => decline(m.organization_id)}>Decline</button></div>}
          </div>))}</div>
      )}
    </>
  )
}
