import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { PlanForm } from '../components/PlanForm'
import { PlanCard } from '../components/PlanCard'
import { Empty, ErrorState, Spinner } from '../ui'
import type { EventRow } from '../lib/types'

type Tab = 'discover' | 'mine' | 'hosting'
const SEL = '*, profiles:host(id,username,display_name,avatar_path)'

export default function Plans() {
  const { uid } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>('discover')
  useEffect(() => { document.title = 'Plans · VYBE' }, [])

  const list = useAsync(async () => {
    const now = new Date().toISOString()
    if (tab === 'mine') {
      const { data, error } = await supabase.from('event_rsvps').select(`status, events!inner(${SEL})`).eq('user_id', uid!).in('status', ['going', 'maybe', 'invited']).gte('events.starts_at', now).limit(50)
      if (error) throw error
      return ((data ?? []) as unknown as { status: string; events: EventRow }[]).map(r => ({ ...r.events, _rsvp: r.status })).sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    }
    let q = supabase.from('events').select(SEL).gte('starts_at', now).order('starts_at').limit(50)
    q = tab === 'hosting' ? q.eq('host', uid!).in('status', ['active', 'draft']) : q.eq('status', 'active')
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as unknown as (EventRow & { _rsvp?: string })[]
  }, [tab, uid])

  if (params.get('new')) return <PlanForm onSaved={id => nav(`/app/plans/${id}`, { replace: true })} onCancel={() => setParams({})} />
  const TABS: { id: Tab; label: string }[] = [{ id: 'discover', label: 'Discover' }, { id: 'mine', label: 'My plans' }, { id: 'hosting', label: 'Hosting' }]
  return (
    <div className="shz">
      <header className="shz-head">
        <div className="row between">
          <h1 className="t-display-sm">Plans</h1>
          <button className="btn primary sm" onClick={() => setParams({ new: '1' })}><Plus size={18} aria-hidden /> New plan</button>
        </div>
        <p className="shz-blurb">{tab === 'discover' ? 'What’s coming up. Say you’re going and your friends can see.' : tab === 'mine' ? 'Plans you’re going to, are interested in, or were invited to.' : 'Plans you’re hosting, drafts included.'}</p>
        <div className="dfilters" role="tablist" aria-label="Plans">
          {TABS.map(t => <button key={t.id} role="tab" type="button" className="dfilter" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
      </header>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title={tab === 'discover' ? 'No upcoming plans' : tab === 'mine' ? "You haven't joined any plans" : "You aren't hosting anything"} action={<button className="btn primary" onClick={() => setParams({ new: '1' })}>Create a plan</button>}>
          {tab === 'mine' ? 'RSVP to a plan from Discover and it will appear here.' : 'Start something and invite your people.'}
        </Empty>
      ) : (
        <ol className="poster-grid" style={{ listStyle: 'none', padding: 0 }}>{list.data.map(e => <li key={e.id}><PlanCard e={e} rsvp={e._rsvp} /></li>)}</ol>
      )}
    </div>
  )
}
