import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Globe2, Lock, Plus } from 'lucide-react'
import { Collapse } from '../components/Collapse'
import { Choice, Wizard } from '../components/Wizard'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { INTERESTS } from '../lib/friends'
import { artStyle, useReadyImage } from '../lib/imgCache'
import { CategoryRail, type Tile } from '../components/discover/CategoryRail'
import { Empty, ErrorState, Field, Spinner, errMsg, useSigned } from '../ui'
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
    const items = (data ?? []) as Community[]
    // Real member counts (people who joined, not requests). Best effort: without them the card just omits the number.
    const counts = new Map<string, number>()
    if (items.length) {
      const { data: m } = await supabase.from('community_members').select('community_id').in('community_id', items.map(i => i.id)).eq('status', 'active').limit(5000)
      for (const r of (m ?? []) as { community_id: string }[]) counts.set(r.community_id, (counts.get(r.community_id) ?? 0) + 1)
    }
    return { items, status, counts: counts.size || !items.length ? counts : new Map<string, number>() }
  }, [tab, uid])

  if (params.get('new')) return <CreateCommunity onDone={id => nav(`/app/communities/${id}`, { replace: true })} onCancel={() => setParams({})} />
  const TABS = [{ id: 'explore' as const, label: 'Explore' }, { id: 'mine' as const, label: 'Mine' }]
  return (
    <div className="shz">
      <header className="shz-head">
        <div className="row between">
          <h1 className="t-display-sm">Communities</h1>
          <button className="btn primary sm" onClick={() => setParams({ new: '1' })}><Plus size={18} aria-hidden /> New</button>
        </div>
        <p className="shz-blurb">Groups that meet up around what they love. Join one, or start your own.</p>
        <div className="dfilters" role="tablist" aria-label="Communities">
          {TABS.map(t => <button key={t.id} role="tab" type="button" className="dfilter" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
      </header>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.items.length ? (
        <Empty title={tab === 'mine' ? "You haven't joined a community" : 'No communities yet'} action={<button className="btn primary" onClick={() => setParams({ new: '1' })}>Start one</button>}>Communities bring people with shared interests together.</Empty>
      ) : (
        (() => {
          // Topic by topic, like Discover: a gliding row of topics, then one swipeable row per topic.
          const groups = new Map<string, Community[]>()
          for (const c of list.data.items) for (const t of (c.topics?.length ? c.topics.slice(0, 1) : ['More communities'])) groups.set(t, [...(groups.get(t) ?? []), c])
          const order = [...INTERESTS.filter(t => groups.has(t)), ...[...groups.keys()].filter(t => !INTERESTS.includes(t))]
          const accents = ['#e0457b', '#7c4dff', '#f08a24', '#1f9d8b', '#3b6fe0', '#c2410c', '#0f766e', '#9333ea']
          const tiles: Tile[] = order.map((t, i) => ({ id: t, label: t, icon: Plus, accent: accents[i % accents.length] }))
          const jump = (k: string) => document.getElementById(`sec-${k.replace(/\s+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          return (
            <>
              {tiles.length > 1 && <CategoryRail tiles={tiles} label="Community topics" onPick={jump} />}
              {order.map(t => (
                <section key={t} className="sec">
                  <h2 id={`sec-${t.replace(/\s+/g, '-')}`} className="sec-h">{t}</h2>
                  <ul className="hscroll">{groups.get(t)!.map(c => <li key={c.id}><CommunityTile c={c} state={list.data!.status.get(c.id)} members={list.data!.counts.get(c.id)} /></li>)}</ul>
                </section>
              ))}
            </>
          )
        })()
      )}
    </div>
  )
}

/** A community as a card: its cover with its picture on the corner; the name, privacy, members and topics written underneath. */
export function CommunityTile({ c, state, members }: { c: Community; state?: string; members?: number }) {
  const cover = useSigned(c.cover_path)
  const coverOk = useReadyImage(cover)
  const pic = useSigned(c.avatar_path ?? null)
  const picOk = useReadyImage(pic)
  const kicker = [c.visibility === 'private' ? 'Private' : 'Public', state === 'active' ? 'Joined' : state === 'pending' ? 'Request pending' : null].filter(Boolean).join(' · ')
  return (
    <Link to={`/app/communities/${c.id}`} className="poster cm-tile" aria-label={`${c.name}, ${kicker}`}>
      <div className="poster-art cm-art" style={artStyle(cover, coverOk)}>
        {!coverOk && <span className="poster-initial" aria-hidden>{c.name.charAt(0).toUpperCase()}</span>}
        <span className="poster-shade" aria-hidden />
        <span className="cm-pic" style={artStyle(pic, picOk)} aria-hidden>{!picOk && c.name.charAt(0).toUpperCase()}</span>
        <span className="poster-over cm-over">
          <span className="poster-cat">{kicker}</span>
          <span className="poster-title clamp-2">{c.name}</span>
          <span className="poster-line clamp-1">{members != null ? `${members} ${members === 1 ? 'member' : 'members'}` : ''}{members != null && (c.description || c.topics.length) ? ' · ' : ''}{c.description || c.topics.slice(0, 3).join(' · ')}</span>
        </span>
      </div>
    </Link>
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
