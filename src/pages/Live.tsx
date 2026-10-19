import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { streamProvider } from '../lib/streaming'
import { ReportSheet } from '../components/Report'
import { Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast } from '../ui'
import { localTimeZone, zonedLocalToUtc } from '../lib/format'
import type { PublicProfile } from '../lib/types'

interface Stream { id: string; host: string; title: string; status: 'scheduled' | 'live' | 'ended' | 'cancelled'; visibility: 'public' | 'friends'; scheduled_for: string | null; profiles: PublicProfile }

export default function Live() {
  const { uid } = useAuth()
  const [creating, setCreating] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  useEffect(() => { document.title = 'Live · VYBE' }, [])
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('live_streams').select('id,host,title,status,visibility,scheduled_for,profiles:host(id,username,display_name,avatar_path)').in('status', ['live', 'scheduled']).order('scheduled_for', { nullsFirst: true }).limit(50)
    if (error) throw error
    return (data ?? []) as unknown as Stream[]
  }, [])
  const cancel = async (id: string) => {
    const { error } = await supabase.from('live_streams').update({ status: 'cancelled' }).eq('id', id)
    if (error) toast(errMsg(error)); else list.reload()
  }
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h1 className="t-title">Live</h1>
        <button className="btn primary sm" onClick={() => setCreating(true)}>Schedule a stream</button>
      </div>
      {!streamProvider.configured && <p className="notice" role="status" style={{ marginBottom: 12 }}>Live broadcasting isn't switched on yet. You can schedule streams now; going live and watching need the streaming service to be connected.</p>}
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title="Nothing live or scheduled">Scheduled streams from you and the people you can see will appear here.</Empty>
      ) : (
        <div className="list">{list.data.map(s => (
          <div key={s.id} className="item">
            <div className="t-meta" style={{ color: s.status === 'live' ? 'var(--danger)' : 'var(--brand)', fontWeight: 600 }}>{s.status === 'live' ? '● Live now' : s.scheduled_for ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.scheduled_for)) : 'Scheduled'}</div>
            <div className="t-name">{s.title}</div>
            <div className="t-meta">by <Link to={`/app/u/${s.profiles.username}`}>@{s.profiles.username}</Link>{s.visibility === 'friends' && ' · Friends only'}</div>
            <div className="row" style={{ marginTop: 6 }}>
              {s.host === uid ? <button className="btn sm danger" onClick={() => cancel(s.id)}>Cancel</button> : <button className="btn ghost sm" onClick={() => setReport(s.id)}>Report</button>}
              {s.status === 'live' && <button className="btn sm" disabled={!streamProvider.configured}>{streamProvider.configured ? 'Watch' : 'Watching unavailable'}</button>}
            </div>
          </div>))}</div>
      )}
      {creating && <ScheduleSheet onClose={() => { setCreating(false); list.reload() }} />}
      {report && <ReportSheet target={{ type: 'stream', id: report }} onClose={() => setReport(null)} />}
    </>
  )
}

function ScheduleSheet({ onClose }: { onClose: () => void }) {
  const { uid } = useAuth()
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [consent, setConsent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const save = () => submit(async () => {
    if (title.trim().length < 2) return setErr('Give your stream a title.')
    const { error } = await supabase.from('live_streams').insert({ host: uid, title: title.trim(), visibility, scheduled_for: when ? zonedLocalToUtc(when, localTimeZone()) : null, recording_consent: consent })
    if (error) return setErr(errMsg(error))
    toast('Stream scheduled'); onClose()
  })
  return (
    <Sheet title="Schedule a stream" onClose={onClose}>
      <Field id="l-title" label="Title"><input id="l-title" className="input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Field>
      <Field id="l-when" label="When (your time zone)"><input id="l-when" type="datetime-local" className="input" value={when} onChange={e => setWhen(e.target.value)} /></Field>
      <Field id="l-vis" label="Who can see it"><select id="l-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value as 'public' | 'friends')}><option value="public">Public</option><option value="friends">Friends</option></select></Field>
      <label className="row" style={{ marginBottom: 16 }}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> <span>I'd like this stream to be recorded for replay</span></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Schedule</button></div>
    </Sheet>
  )
}
