import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { PlanForm } from '../components/PlanForm'
import { Empty, ErrorState, Spinner, Tabs } from '../ui'
import { formatEventTime, formatPrice } from '../lib/format'
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
    let q = supabase.from('events').select(SEL).eq('status', 'active').gte('starts_at', now).order('starts_at').limit(50)
    if (tab === 'hosting') q = q.eq('host', uid!)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as unknown as (EventRow & { _rsvp?: string })[]
  }, [tab, uid])

  if (params.get('new')) return <PlanForm onSaved={id => nav(`/app/plans/${id}`, { replace: true })} onCancel={() => setParams({})} />
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h1 className="t-title">Plans</h1>
        <button className="btn primary sm" onClick={() => setParams({ new: '1' })}><Plus size={18} aria-hidden /> New plan</button>
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'discover', label: 'Discover' }, { id: 'mine', label: 'My plans' }, { id: 'hosting', label: 'Hosting' }]} />
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title={tab === 'discover' ? 'No upcoming plans' : tab === 'mine' ? "You haven't joined any plans" : "You aren't hosting anything"} action={<button className="btn primary" onClick={() => setParams({ new: '1' })}>Create a plan</button>}>
          {tab === 'mine' ? 'RSVP to a plan from Discover and it will appear here.' : 'Start something and invite your people.'}
        </Empty>
      ) : (
        <div className="list">
          {list.data.map(e => (
            <Link key={e.id} to={`/app/plans/${e.id}`} className="item link" style={{ display: 'block', padding: '14px 4px' }}>
              <div className="t-meta" style={{ color: 'var(--brand)', fontWeight: 600 }}>{formatEventTime(e.starts_at, e.timezone)}</div>
              <div className="t-name">{e.title}</div>
              <div className="t-meta clamp-1">{[e.location, e.visibility !== 'public' ? (e.visibility === 'invite' ? 'Invite only' : 'Friends') : null, formatPrice(e.price_cents, e.currency), e._rsvp === 'invited' ? 'You are invited' : e._rsvp === 'going' ? "You're going" : e._rsvp === 'maybe' ? 'Maybe' : null].filter(Boolean).join(' · ')}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
