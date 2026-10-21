import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Globe2, Lock, Plus } from 'lucide-react'
import { Collapse } from '../components/Collapse'
import { Choice, Wizard } from '../components/Wizard'
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
    setErr('')
    if (name.trim().length < 2) return setErr('Give your community a name.')
    const { data, error } = await supabase.from('communities').insert({ name: name.trim(), description: description.trim(), rules: rules.trim(), visibility, topics, created_by: uid }).select('id').single()
    if (error) return setErr(errMsg(error))
    onDone(data.id)
  })
  const rows: [string, string, string][] = [
    ['Name', name || 'No name yet', 'name'], ['About', description || 'Not set', 'about'], ['Privacy', visibility === 'private' ? 'Private — members are approved' : 'Public — anyone can join', 'privacy'],
    ['Topics', topics.join(', ') || 'None', 'topics'], ['Rules', rules || 'None', 'rules'],
  ]
  return (
    <Wizard title="Start a community" onClose={onCancel} dirty={Boolean(name || description || rules || topics.length)} error={err}
      actions={[{ label: 'Create community', primary: true, busy, onClick: create }]}
      steps={[
        { id: 'name', phase: 'Identity', title: 'What is it called?', hint: 'Pick a name people will remember.', check: () => (name.trim().length < 2 ? 'Give your community a name.' : null), body:
          <Field id="c-name" label="Name"><input id="c-name" className="input" value={name} maxLength={80} autoFocus onChange={e => setName(e.target.value)} placeholder="e.g. Cape Town Runners" /></Field> },
        { id: 'about', phase: 'Identity', title: 'What is it about?', hint: 'A sentence or two helps the right people find it.', optional: !description, body:
          <Field id="c-desc" label="Description"><textarea id="c-desc" className="textarea" rows={5} value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></Field> },
        { id: 'privacy', phase: 'Access', title: 'Who can join?', body:
          <Choice label="Privacy" value={visibility} onChange={setVisibility} options={[
            { value: 'public', title: 'Public', text: 'Anyone can join and see posts and plans', icon: <Globe2 size={22} /> },
            { value: 'private', title: 'Private', text: 'Anyone can find it and ask to join; only approved members see posts and plans', icon: <Lock size={22} /> }]} /> },
        { id: 'topics', phase: 'Access', title: 'Pick some topics', hint: 'Up to 10. They help people discover your community.', optional: !topics.length, body:
          <Collapse title="Topics" summary={topics.length ? `${topics.length} selected` : 'Tap to choose'} defaultOpen>
            <div className="chips" role="group" aria-label="Topics">{INTERESTS.map(i => <button key={i} type="button" className="chip" aria-pressed={topics.includes(i)} onClick={() => setTopics(c => c.includes(i) ? c.filter(x => x !== i) : c.length < 10 ? [...c, i] : c)}>{i}</button>)}</div>
          </Collapse> },
        { id: 'rules', phase: 'Access', title: 'Any ground rules?', hint: 'Shown to people before they join.', optional: !rules, body:
          <Field id="c-rules" label="Community rules"><textarea id="c-rules" className="textarea" rows={5} value={rules} maxLength={2000} onChange={e => setRules(e.target.value)} /></Field> },
        { id: 'review', phase: 'Review', title: 'Ready to create?', hint: 'Check the details. Tap Change to fix anything.', body: ({ go }) => (
          <dl className="wz-review">{rows.map(([k, v, at]) => <div key={k}><span><dt>{k}</dt><dd>{v}</dd></span><button type="button" onClick={() => go(at)}>Change</button></div>)}</dl>
        ) },
      ]} />
  )
}
