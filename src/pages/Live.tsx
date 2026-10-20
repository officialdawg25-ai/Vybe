import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { ReportSheet } from '../components/Report'
import { Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast } from '../ui'
import { localTimeZone, zonedLocalToUtc } from '../lib/format'
import { isMissingSchema } from '../lib/tickets'
import type { PublicProfile } from '../lib/types'

interface Stream { id: string; host: string; title: string; status: 'scheduled' | 'live' | 'ended' | 'cancelled'; visibility: 'public' | 'friends'; scheduled_for: string | null; access?: 'open' | 'ticket'; event_id?: string | null; viewers_peak?: number; profiles: PublicProfile }

export default function Live() {
  const { uid } = useAuth()
  const [creating, setCreating] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  useEffect(() => { document.title = 'Live · VYBE' }, [])
  const list = useAsync(async () => {
    const cols = 'id,host,title,status,visibility,scheduled_for,access,event_id,viewers_peak,profiles:host(id,username,display_name,avatar_path)'
    const q = (select: string) => supabase.from('live_streams').select(select).in('status', ['live', 'scheduled']).order('scheduled_for', { nullsFirst: true }).limit(50)
    let res = await q(cols)
    if (res.error && isMissingSchema(res.error)) res = await q('id,host,title,status,visibility,scheduled_for,profiles:host(id,username,display_name,avatar_path)')
    if (res.error) throw res.error
    return (res.data ?? []) as unknown as Stream[]
  }, [])
  // Streams going live or ending update this list without a refresh (Realtime respects the same row visibility rules).
  useEffect(() => {
    const ch = supabase.channel('live-list').on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, () => list.reload()).subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const cancel = async (id: string) => {
    const { error } = await supabase.from('live_streams').update({ status: 'cancelled' }).eq('id', id)
    if (error) toast(errMsg(error)); else list.reload()
  }
  const live = list.data?.filter(s => s.status === 'live') ?? []
  const soon = list.data?.filter(s => s.status === 'scheduled') ?? []
  const row = (s: Stream) => (
    <div key={s.id} className="item">
      <div className="t-meta" style={{ color: s.status === 'live' ? 'var(--danger)' : 'var(--brand)', fontWeight: 600 }}>{s.status === 'live' ? `● Live now${s.viewers_peak ? ` · ${s.viewers_peak} peak` : ''}` : s.scheduled_for ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.scheduled_for)) : 'Ready when the host is'}</div>
      <div className="t-name">{s.title}</div>
      <div className="t-meta">by <Link to={`/app/u/${s.profiles.username}`}>@{s.profiles.username}</Link>{s.visibility === 'friends' && ' · Friends only'}{s.access === 'ticket' && ' · Ticket holders'}</div>
      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        {s.host === uid ? <>
          <Link className="btn primary sm" to={`/app/live/${s.id}/host`}>{s.status === 'live' ? 'Back to your stream' : 'Go live'}</Link>
          <button className="btn sm danger" onClick={() => cancel(s.id)}>Cancel</button>
        </> : <>
          {s.status === 'live' ? <Link className="btn primary sm" to={`/app/live/${s.id}`}>Watch</Link> : <Link className="btn sm" to={`/app/live/${s.id}`}>Open</Link>}
          <button className="btn ghost sm" onClick={() => setReport(s.id)}>Report</button>
        </>}
      </div>
    </div>
  )
  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h1 className="t-title">Live</h1>
        <button className="btn primary sm" onClick={() => setCreating(true)}>Schedule a stream</button>
      </div>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? (
        <Empty title="Nothing live or scheduled">Streams from you and the people you can see will appear here.</Empty>
      ) : (
        <>
          {live.length > 0 && <section aria-label="Live now"><h2 className="t-section">Live now</h2><div className="list">{live.map(row)}</div></section>}
          {soon.length > 0 && <section aria-label="Coming up" style={{ marginTop: 16 }}><h2 className="t-section">Coming up</h2><div className="list">{soon.map(row)}</div></section>}
        </>
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
  const [eventId, setEventId] = useState('')
  const [access, setAccess] = useState<'open' | 'ticket'>('open')
  const [consent, setConsent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const events = useAsync(async () => {
    const { data } = await supabase.from('events').select('id,title,host,organization_id').eq('status', 'active').gte('starts_at', new Date(Date.now() - 12 * 3600_000).toISOString()).order('starts_at').limit(50)
    const mine = (data ?? []) as { id: string; title: string; host: string; organization_id: string | null }[]
    const manageable = await Promise.all(mine.map(async e => e.host === uid || (e.organization_id ? Boolean((await supabase.rpc('can_manage_event', { eid: e.id })).data) : false)))
    return mine.filter((_, i) => manageable[i])
  }, [uid])
  const save = () => submit(async () => {
    if (title.trim().length < 2) return setErr('Give your stream a title.')
    const row: Record<string, unknown> = { host: uid, title: title.trim(), visibility, scheduled_for: when ? zonedLocalToUtc(when, localTimeZone()) : null, recording_consent: consent }
    if (eventId) { row.event_id = eventId; row.access = access }
    const { error } = await supabase.from('live_streams').insert(row)
    if (error) return setErr(errMsg(error))
    toast('Stream scheduled'); onClose()
  })
  return (
    <Sheet title="Schedule a stream" onClose={onClose}>
      <Field id="l-title" label="Title"><input id="l-title" className="input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Field>
      <Field id="l-when" label="When (your time zone)" hint="Leave empty to go live whenever you’re ready."><input id="l-when" type="datetime-local" className="input" value={when} onChange={e => setWhen(e.target.value)} /></Field>
      {!!events.data?.length && (
        <Field id="l-ev" label="Attach to a plan (optional)"><select id="l-ev" className="select" value={eventId} onChange={e => setEventId(e.target.value)}><option value="">None</option>{events.data.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select></Field>
      )}
      {eventId && <Field id="l-acc" label="Who can watch" hint="Ticket-only streams can be watched by people holding a valid ticket for the plan."><select id="l-acc" className="select" value={access} onChange={e => setAccess(e.target.value as 'open' | 'ticket')}><option value="open">Anyone allowed by the visibility below</option><option value="ticket">Ticket holders only</option></select></Field>}
      <Field id="l-vis" label="Visibility"><select id="l-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value as 'public' | 'friends')}><option value="public">Public</option><option value="friends">Friends</option></select></Field>
      <label className="row" style={{ marginBottom: 16 }}><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> <span>I’d like this stream to be recorded for replay (recordings are not switched on yet)</span></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Schedule</button></div>
    </Sheet>
  )
}
