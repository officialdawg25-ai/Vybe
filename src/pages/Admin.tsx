import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { Empty, ErrorState, Spinner, Tabs, errMsg, toast } from '../ui'
import { timeAgo } from '../lib/format'

type Status = 'submitted' | 'reviewing' | 'escalated' | 'actioned' | 'dismissed'
interface Report { id: string; entity_type: string; entity_id: string; reason: string; status: Status; created_at: string }
interface Audit { id: number; actor: string | null; action: string; entity_type: string; created_at: string }

/** Moderation queue (the admin portal's home). Staff-only. Visibility comes from RLS (`is_staff()`); non-staff see an empty, denied state. */
export default function Moderation() {
  const [tab, setTab] = useState<'open' | 'closed' | 'audit'>('open')
  const [ctx, setCtx] = useState<Record<string, string>>({})
  useEffect(() => { document.title = 'Moderation · VYBE' }, [])
  const staff = useAsync(async () => { const { data, error } = await supabase.rpc('is_staff'); if (error) throw error; return Boolean(data) }, [])
  const reports = useAsync(async () => {
    if (!staff.data) return []
    const open = tab === 'open'
    const { data, error } = await supabase.from('reports').select('*').in('status', open ? ['submitted', 'reviewing', 'escalated'] : ['actioned', 'dismissed']).order('created_at').limit(100)
    if (error) throw error
    return (data ?? []) as Report[]
  }, [tab, staff.data])
  const audit = useAsync(async () => {
    if (!staff.data || tab !== 'audit') return []
    const { data, error } = await supabase.from('audit_log').select('id,actor,action,entity_type,created_at').order('id', { ascending: false }).limit(100)
    if (error) throw error
    return (data ?? []) as Audit[]
  }, [tab, staff.data])

  if (staff.loading) return <Spinner />
  if (staff.error) return <ErrorState message={staff.error} onRetry={staff.reload} />
  if (!staff.data) return <Empty title="Not available">This area is for VYBE moderators.</Empty>

  const setStatus = async (r: Report, status: Status) => {
    const { error } = await supabase.from('reports').update({ status }).eq('id', r.id)
    if (error) toast(errMsg(error)); else reports.reload()
  }
  const view = async (r: Report) => {
    const { data, error } = await supabase.rpc('staff_report_context', { rid: r.id })
    if (error) return toast(errMsg(error))
    setCtx(c => ({ ...c, [r.id]: (data as { text: string | null; gone?: boolean }).gone ? '(content no longer exists)' : String((data as { text: string }).text ?? '') }))
  }
  const remove = async (r: Report) => {
    if (!confirm('Remove this content? This is recorded in the audit log.')) return
    const { error } = await supabase.rpc('staff_remove_content', { rid: r.id })
    if (error) toast(errMsg(error)); else { toast('Content removed'); reports.reload() }
  }

  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 12 }}>Moderation</h1>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'open', label: 'Open reports' }, { id: 'closed', label: 'Resolved' }, { id: 'audit', label: 'Audit log' }]} />
      {tab === 'audit' ? (audit.loading ? <Spinner /> : <div className="list">{audit.data?.map(a => <div key={a.id} className="item t-meta">{timeAgo(a.created_at)} · <b>{a.action}</b> · {a.entity_type} · actor {a.actor?.slice(0, 8) ?? 'system'}</div>)}</div>)
        : reports.loading ? <Spinner /> : reports.error ? <ErrorState message={reports.error} onRetry={reports.reload} /> : !reports.data?.length ? <Empty title="Queue is clear">No reports in this view.</Empty> : (
          <div className="list">{reports.data.map(r => (
            <div key={r.id} className="item stack" style={{ gap: 6 }}>
              <div className="t-meta"><b>{r.entity_type}</b> · {r.status} · {timeAgo(r.created_at)}</div>
              <p style={{ whiteSpace: 'pre-wrap' }}>“{r.reason}”</p>
              {ctx[r.id] !== undefined && <blockquote className="notice" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{ctx[r.id] || '(no text content)'}</blockquote>}
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => view(r)}>View reported content</button>
                {tab === 'open' && <>
                  {r.status === 'submitted' && <button className="btn sm" onClick={() => setStatus(r, 'reviewing')}>Start review</button>}
                  <button className="btn sm" onClick={() => setStatus(r, 'escalated')}>Escalate</button>
                  <button className="btn sm" onClick={() => setStatus(r, 'dismissed')}>Dismiss</button>
                  {r.entity_type !== 'profile' && <button className="btn sm danger" onClick={() => remove(r)}>Remove content</button>}
                </>}
              </div>
            </div>))}</div>
        )}
    </>
  )
}

