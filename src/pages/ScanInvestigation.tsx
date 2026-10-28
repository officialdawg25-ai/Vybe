import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { caseDecideAction, caseOpen, caseRequestAction, caseUpdate, scanDetail, scanSearch, type ScanDetail, type ScanFilters, type ScanRow } from '../lib/admission'
import { Empty, ErrorState, Field, Sheet, Spinner, errMsg, toast } from '../ui'

const DECISIONS = ['ACCEPTED', 'ALREADY_USED', 'WRONG_EVENT', 'NOT_YET_VALID', 'EXPIRED', 'INVALID', 'REVOKED', 'WRONG_GATE_OR_ZONE', 'WRONG_SESSION', 'PAYMENT_NOT_CONFIRMED',
  'EVENT_CANCELLED', 'EVENT_POSTPONED', 'MANUAL_REVIEW', 'QR_EXPIRED', 'STATIC_CODE', 'FORBIDDEN', 'RATE_LIMITED', 'EXITED', 'MANUAL_ADMIT']
const PAGE = 25
const when = (iso: string | null, tz?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', ...(tz ? { timeZone: tz } : {}) }) : '—')

/**
 * /app/scans/:eventId — for the event's managers and VYBE staff. Searches the scan log on the server (paged), shows a scan in
 * the context of the ticket's whole history, and runs investigation cases. Nothing here edits or deletes a scan: decisions are
 * new, attributable records, and the two high-impact actions need a second person.
 */
export default function ScanInvestigation() {
  const { eventId } = useParams()
  useEffect(() => { document.title = 'Scan investigation · VYBE' }, [])
  const ev = useAsync(async () => {
    const { data, error } = await supabase.from('events').select('id,title,timezone').eq('id', eventId!).maybeSingle()
    if (error) throw error
    const gates = await supabase.from('event_gates').select('id,name').eq('event_id', eventId!).order('name')
    const types = await supabase.from('ticket_types').select('id,name').eq('event_id', eventId!).order('sort')
    return data ? { ...(data as { id: string; title: string; timezone: string }), gates: (gates.data ?? []) as { id: string; name: string }[], types: (types.data ?? []) as { id: string; name: string }[] } : null
  }, [eventId])
  const [f, setF] = useState<ScanFilters>({})
  const [page, setPage] = useState(0)
  const [res, setRes] = useState<{ total: number; rows: ScanRow[] } | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const search = async (p = page) => { setErr(''); try { setRes(await scanSearch(eventId!, f, PAGE, p * PAGE)) } catch (e) { setErr(errMsg(e)); setRes(null) } }
  useEffect(() => { void search(page) }, [page])   // eslint-disable-line react-hooks/exhaustive-deps
  if (ev.loading) return <Spinner />
  if (ev.error) return <ErrorState message={ev.error} onRetry={ev.reload} />
  if (!ev.data) return <Empty title="Event not found" />
  const set = (k: keyof ScanFilters, v: string | boolean) => setF(x => ({ ...x, [k]: v }))
  const tz = ev.data.timezone
  return (
    <div className="inv">
      <div className="row" style={{ marginBottom: 8 }}><Link className="icon-btn" to={`/app/plans/${ev.data.id}`} aria-label="Back to the event"><ArrowLeft size={22} /></Link>
        <div><h1 className="t-title">Scan investigation</h1><p className="t-meta">{ev.data.title} · times in {tz}</p></div></div>
      <form className="inv-filters" onSubmit={e => { e.preventDefault(); setPage(0); void search(0) }}>
        <Field id="if-ref" label="Ticket reference"><input id="if-ref" className="input" placeholder="VT-…" value={f.ref ?? ''} onChange={e => set('ref', e.target.value)} /></Field>
        <Field id="if-order" label="Order reference"><input id="if-order" className="input" placeholder="first 8 characters" value={f.order ?? ''} onChange={e => set('order', e.target.value)} /></Field>
        <Field id="if-dec" label="Outcome"><select id="if-dec" className="input" value={f.decision ?? ''} onChange={e => set('decision', e.target.value)}><option value="">Any</option>{DECISIONS.map(d => <option key={d}>{d}</option>)}</select></Field>
        <Field id="if-gate" label="Gate"><select id="if-gate" className="input" value={f.gate ?? ''} onChange={e => set('gate', e.target.value)}><option value="">Any</option>{ev.data.gates.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <Field id="if-type" label="Ticket type"><select id="if-type" className="input" value={f.type ?? ''} onChange={e => set('type', e.target.value)}><option value="">Any</option>{ev.data.types.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <Field id="if-mode" label="How validated"><select id="if-mode" className="input" value={f.mode ?? ''} onChange={e => set('mode', e.target.value)}><option value="">Any</option><option value="online">Online</option><option value="local">Venue network</option><option value="offline">Offline phone</option><option value="manual">Manual decision</option></select></Field>
        <Field id="if-sync" label="Sync"><select id="if-sync" className="input" value={f.sync ?? ''} onChange={e => set('sync', e.target.value)}><option value="">Any</option><option value="confirmed">Confirmed</option><option value="conflict">Conflict</option><option value="rejected">Rejected</option><option value="recorded">Recorded</option></select></Field>
        <Field id="if-case" label="Case"><select id="if-case" className="input" value={f.case_status ?? ''} onChange={e => set('case_status', e.target.value)}><option value="">Any</option>{['open', 'under_review', 'evidence_requested', 'escalated', 'resolved', 'closed'].map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</select></Field>
        <Field id="if-dev" label="Device"><input id="if-dev" className="input" value={f.device ?? ''} onChange={e => set('device', e.target.value)} /></Field>
        <Field id="if-from" label="From"><input id="if-from" type="datetime-local" className="input" value={f.from?.slice(0, 16) ?? ''} onChange={e => set('from', e.target.value ? new Date(e.target.value).toISOString() : '')} /></Field>
        <Field id="if-to" label="To"><input id="if-to" type="datetime-local" className="input" value={f.to?.slice(0, 16) ?? ''} onChange={e => set('to', e.target.value ? new Date(e.target.value).toISOString() : '')} /></Field>
        <label className="ds-inline"><input type="checkbox" checked={!!f.conflicts} onChange={e => set('conflicts', e.target.checked)} /> Repeats and conflicts only</label>
        <button className="btn primary">Search</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      {res && (
        <>
          <p className="t-meta" aria-live="polite">{res.total} scan{res.total === 1 ? '' : 's'}</p>
          <div className="inv-table-wrap"><table className="ds-table inv-table">
            <thead><tr><th scope="col">Time</th><th scope="col">Outcome</th><th scope="col">Ticket</th><th scope="col">Gate</th><th scope="col">Validated</th><th scope="col">Scanner · device</th><th scope="col">Case</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
            <tbody>{res.rows.map(r => (
              <tr key={r.id}>
                <td>{when(r.at, tz)}</td><td><b>{r.decision}</b>{r.sync && r.sync !== 'confirmed' ? <span className={`inv-sync s-${r.sync}`}> · {r.sync}</span> : null}</td>
                <td>{r.ref ?? '—'}{r.type ? <span className="t-meta"> · {r.type}</span> : null}{r.ticket_status && r.ticket_status !== 'valid' && r.ticket_status !== 'used' ? <span className="t-meta"> · now {r.ticket_status}</span> : null}</td>
                <td>{r.gate ?? '—'}</td><td>{r.mode}</td><td>{r.scanner ?? '—'}{r.device ? <span className="t-meta"> · {r.device}</span> : null}</td>
                <td>{r.case ? `#${r.case}` : ''}</td><td><button className="btn ghost sm" onClick={() => setOpen(r.id)}>Details</button></td>
              </tr>))}
              {!res.rows.length && <tr><td colSpan={8} className="t-meta">No scans match.</td></tr>}</tbody>
          </table></div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span className="t-meta">Page {page + 1} of {Math.max(1, Math.ceil(res.total / PAGE))}</span>
            <button className="btn sm" disabled={(page + 1) * PAGE >= res.total} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </>
      )}
      {open !== null && <ScanSheet id={open} tz={tz} onClose={() => { setOpen(null); void search(page) }} />}
    </div>
  )
}

const SAY: Record<string, string> = {
  repeat_scan: 'The same ticket was scanned more than once. That alone is not wrongdoing: people get rescanned, phones retry, staff test.',
  offline_conflict: 'Two places admitted this ticket while at least one was offline. The real order of entries may be uncertain.',
  sync_rejected: 'Admitted offline, but the central record says this ticket could not be admitted.',
  after_revocation: 'Admitted by a scanner session after it was revoked.',
  sequence_gap: 'Scans from one phone arrived with numbers missing (lost records or a reset phone).',
  clock_anomaly: 'A phone’s clock looked wrong: its times may not be trustworthy.',
  manual: 'Opened by a person.',
}

function ScanSheet({ id, tz, onClose }: { id: number; tz: string; onClose: () => void }) {
  const d = useAsync(() => scanDetail(id), [id])
  const [text, setText] = useState('')
  const act = async (f: () => Promise<unknown>, done: string) => { try { await f(); toast(done); setText(''); d.reload() } catch (e) { toast(errMsg(e)) } }
  return (
    <Sheet title={`Scan #${id}`} onClose={onClose}>
      {d.loading ? <Spinner /> : d.error ? <ErrorState message={d.error} onRetry={d.reload} /> : d.data && <ScanBody d={d.data} tz={tz} text={text} setText={setText} act={act} />}
    </Sheet>
  )
}

function ScanBody({ d, tz, text, setText, act }: { d: ScanDetail; tz: string; text: string; setText: (s: string) => void; act: (f: () => Promise<unknown>, done: string) => Promise<void> }) {
  const c = d.cases[0]
  return (
    <div className="inv-detail">
      <dl className="pass-facts">
        <div><dt>Outcome</dt><dd>{d.scan.decision}{d.scan.reason ? ` — ${d.scan.reason}` : ''}</dd></div>
        <div><dt>Event</dt><dd>{d.event.title}</dd></div>
        <div><dt>Received</dt><dd>{when(d.scan.at, tz)}{d.scan.device_time ? ` · phone said ${when(d.scan.device_time, tz)}` : ''}</dd></div>
        <div><dt>Where</dt><dd>{d.scan.gate ?? 'No gate'} · {d.scan.scanner ?? '—'}{d.scan.device ? ` · ${d.scan.device}` : ''}</dd></div>
        <div><dt>Validated</dt><dd>{d.scan.mode}{d.scan.sync ? ` · sync ${d.scan.sync}` : ''}{d.scan.flags?.length ? ` · ${d.scan.flags.join(', ')}` : ''}</dd></div>
        {d.ticket && <>
          <div><dt>Ticket</dt><dd>{d.ticket.ref} · {d.ticket.type} · now {d.ticket.status}{d.ticket.revoked_reason ? ` (${d.ticket.revoked_reason})` : ''}</dd></div>
          <div><dt>Seat</dt><dd>{d.ticket.seat ?? 'No reserved seat'}</dd></div>
          <div><dt>Order</dt><dd>{d.ticket.order} · {d.ticket.order_status}{d.ticket.refund ? ` · refund ${d.ticket.refund}` : ''}{d.ticket.transfers ? ' · transferred' : ''}</dd></div>
        </>}
      </dl>
      {d.history.length > 0 && <section><h3 className="t-name">Every scan of this ticket, in order</h3>
        <ol className="inv-hist">{d.history.map((h, i) => <li key={h.id} className={h.id === d.scan.id ? 'me' : ''}><b>{i + 1}. {h.decision}</b> · {when(h.at, tz)}{h.device_time ? ` (phone ${when(h.device_time, tz)})` : ''} · {h.gate ?? 'no gate'} · {h.mode}{h.sync ? ` · ${h.sync}` : ''} · {h.scanner ?? '—'}</li>)}</ol>
        {d.history.some(h => h.mode === 'offline' || h.mode === 'local') && <p className="t-meta">Offline times come from phone clocks; when phones were disconnected, which entry really came first may not be knowable.</p>}
      </section>}
      {d.admissions.length > 0 && <p className="t-meta">Admissions recorded: {d.admissions.map(a => `${a.direction === 'in' ? 'in' : 'out'} ${when(a.at, tz)} (${a.mode}${a.override ? ', supervised' : ''})`).join(' · ')}</p>}
      <section className="inv-case">
        {!c ? (
          <>
            <Field id="inv-sum" label="Open a case"><input id="inv-sum" className="input" value={text} maxLength={500} onChange={e => setText(e.target.value)} placeholder="What needs checking" /></Field>
            <button className="btn sm" disabled={text.trim().length < 3} onClick={() => void act(() => caseOpen(d.scan.id, text.trim()), 'Case opened')}>Open case</button>
          </>
        ) : (
          <>
            <h3 className="t-name">Case #{c.id} · {c.status.replace('_', ' ')}</h3>
            <p className="t-meta">{SAY[c.kind] ?? c.kind}{c.summary ? ` ${c.summary}` : ''}</p>
            {c.resolution && <p><b>Resolution:</b> {c.resolution}</p>}
            <ol className="inv-hist">{(c.events ?? []).map((e, i) => <li key={i}>{when(e.at, tz)} · {e.actor ?? 'system'} · {e.action.replace('_', ' ')}{typeof e.detail.text === 'string' ? `: ${e.detail.text}` : typeof e.detail.reason === 'string' ? `: ${e.detail.reason}` : ''}</li>)}</ol>
            {(c.actions ?? []).filter(a => a.status === 'pending').map(a => (
              <div key={a.id} className="notice">
                <b>{a.kind === 'manual_admit' ? 'Record a supervised admission' : 'Revoke this ticket'}</b> — asked by {a.requested_by}: {a.reason}
                {a.mine ? <p className="t-meta">Waiting for a second person (another organiser or VYBE) to approve.</p> : (
                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <button className="btn sm" disabled={text.trim().length < 5} onClick={() => void act(() => caseDecideAction(a.id, true, text.trim()), 'Approved and recorded')}>Approve</button>
                    <button className="btn ghost sm" disabled={text.trim().length < 5} onClick={() => void act(() => caseDecideAction(a.id, false, text.trim()), 'Rejected')}>Reject</button>
                    <span className="t-meta">Write your reason below first.</span>
                  </div>)}
              </div>))}
            {c.status !== 'closed' && <>
              <Field id="inv-note" label="Note, reason or resolution"><textarea id="inv-note" className="input" rows={2} maxLength={1000} value={text} onChange={e => setText(e.target.value)} /></Field>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={text.trim().length < 3} onClick={() => void act(() => caseUpdate(c.id, 'note', text.trim()), 'Note added')}>Add note</button>
                {(['under_review', 'evidence_requested', 'escalated', 'resolved', 'closed'] as const).filter(st => st !== c.status).map(st =>
                  <button key={st} className="btn ghost sm" disabled={text.trim().length < 3} onClick={() => void act(() => caseUpdate(c.id, 'status', text.trim(), st), `Case ${st.replace('_', ' ')}`)}>{st === 'evidence_requested' ? 'Request evidence' : st.replace('_', ' ')}</button>)}
              </div>
              {d.ticket && !(c.actions ?? []).some(a => a.status === 'pending') && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn ghost sm" disabled={text.trim().length < 5} onClick={() => void act(() => caseRequestAction(c.id, 'manual_admit', text.trim()), 'Asked for approval')}>Ask to record a supervised admission</button>
                {d.ticket.status === 'valid' && <button className="btn ghost sm" disabled={text.trim().length < 5} onClick={() => void act(() => caseRequestAction(c.id, 'revoke_ticket', text.trim()), 'Asked for approval')}>Ask to revoke the ticket</button>}
              </div>}
            </>}
          </>
        )}
      </section>
    </div>
  )
}
