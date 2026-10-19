import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { INTERESTS } from '../lib/friends'
import { Empty, ErrorState, Field, Spinner, Tabs, errMsg } from '../ui'
import type { Community } from '../lib/types'

export default function Communities() {
  const { uid } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'explore' | 'mine'>('explore')
  useEffect(() => { document.title = 'Communities · VYBE' }, [])
  const list = useAsync(async () => {
    const { data: mem, error: e1 } = await supabase.from('community_members').select('community_id,status').eq('user_id', uid!)
    if (e1) throw e1
    const status = new Map((mem ?? []).map(m => [m.community_id, m.status as string]))
    let q = supabase.from('communities').select('*').order('created_at', { ascending: false }).limit(50)
    if (tab === 'mine') { const ids = [...status.keys()]; q = q.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']) }
    const { data, error } = await q
    if (error) throw error
    return { items: (data ?? []) as Community[], status }
  }, [tab, uid])

  if (params.get('new')) return <CreateCommunity onDone={id => nav(`/app/communities/${id}`, { replace: true })} onCancel={() => setParams({})} />
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h1 className="t-title">Communities</h1>
        <button className="btn primary sm" onClick={() => setParams({ new: '1' })}><Plus size={18} aria-hidden /> New</button>
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'explore', label: 'Explore' }, { id: 'mine', label: 'Mine' }]} />
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.items.length ? (
        <Empty title={tab === 'mine' ? "You haven't joined a community" : 'No communities yet'} action={<button className="btn primary" onClick={() => setParams({ new: '1' })}>Start one</button>}>Communities bring people with shared interests together.</Empty>
      ) : (
        <div className="list">{list.data.items.map(c => (
          <Link key={c.id} to={`/app/communities/${c.id}`} className="item link" style={{ display: 'block', padding: '14px 4px' }}>
            <div className="t-name">{c.name} <span className="t-meta">· {c.visibility === 'private' ? 'Private' : 'Public'}{list.data!.status.get(c.id) === 'pending' ? ' · Request pending' : list.data!.status.get(c.id) === 'active' ? ' · Joined' : ''}</span></div>
            <div className="t-meta clamp-1">{c.description || c.topics.join(', ')}</div>
          </Link>))}</div>
      )}
    </>
  )
}

function CreateCommunity({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const { uid } = useAuth()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rules, setRules] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [topics, setTopics] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const create = () => submit(async () => {
    if (name.trim().length < 2) return setErr('Give your community a name.')
    const { data, error } = await supabase.from('communities').insert({ name: name.trim(), description: description.trim(), rules: rules.trim(), visibility, topics, created_by: uid }).select('id').single()
    if (error) return setErr(errMsg(error))
    onDone(data.id)
  })
  return (
    <div>
      <h1 className="t-title" style={{ marginBottom: 16 }}>Start a community</h1>
      <Field id="c-name" label="Name"><input id="c-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
      <Field id="c-desc" label="What's it about?"><textarea id="c-desc" className="textarea" value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></Field>
      <Field id="c-rules" label="Community rules (optional)"><textarea id="c-rules" className="textarea" value={rules} maxLength={2000} onChange={e => setRules(e.target.value)} /></Field>
      <Field id="c-vis" label="Privacy" hint={visibility === 'private' ? 'Anyone can find it and request to join. Only approved members see posts and plans.' : 'Anyone can join and see posts and plans.'}>
        <select id="c-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value as 'public' | 'private')}><option value="public">Public</option><option value="private">Private</option></select>
      </Field>
      <div className="field"><span id="c-top" style={{ fontWeight: 600, fontSize: '.875rem' }}>Topics</span>
        <div className="chips" role="group" aria-labelledby="c-top">{INTERESTS.map(i => <button key={i} className="chip" aria-pressed={topics.includes(i)} onClick={() => setTopics(c => c.includes(i) ? c.filter(x => x !== i) : c.length < 10 ? [...c, i] : c)}>{i}</button>)}</div></div>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 16 }}><button className="btn primary" disabled={busy} onClick={create}>Create community</button><button className="btn ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  )
}
