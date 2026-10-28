import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { ErrorState, Field, Spinner, errMsg, toast } from '../../ui'

interface Policy { category: string; description: string; purpose: string; basis: string; period: string | null; action: string; enforceable: boolean; approved: boolean; approval_reference: string; approved_at: string | null; version: number }
interface Run { id: number; dry_run: boolean; started_at: string; status: string; counts: Record<string, number>; errors: { category: string; error: string }[] }
interface Hold { id: number; scope_type: string; scope_id: string; reason: string; placed_at: string; released_at: string | null }
const rpc = async <T,>(fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data as T }

/**
 * Admin → Privacy & retention (migration 44). The registry of what VYBE Tickets keeps, for how long and why. Every period is a
 * proposal until an approval reference from the legal adviser / Information Officer is recorded; a dry run shows what a policy
 * would touch first. Legal holds always win. This screen does not make VYBE POPIA-compliant on its own.
 */
export default function AdminPrivacy() {
  useEffect(() => { document.title = 'Privacy & retention · Admin · VYBE' }, [])
  const data = useAsync(async () => {
    const [p, r, h] = await Promise.all([
      supabase.from('retention_policies').select('*').order('category'),
      supabase.from('retention_runs').select('id,dry_run,started_at,status,counts,errors').order('id', { ascending: false }).limit(10),
      supabase.from('legal_holds').select('*').is('released_at', null).order('placed_at', { ascending: false }),
    ])
    if (p.error) throw p.error
    return { policies: (p.data ?? []) as Policy[], runs: (r.data ?? []) as Run[], holds: (h.data ?? []) as Hold[] }
  }, [])
  const [dry, setDry] = useState<Record<string, number> | null>(null)
  if (data.loading) return <Spinner />
  if (data.error) return <ErrorState message={data.error} onRetry={data.reload} />
  const d = data.data!
  const run = async (dryRun: boolean) => {
    if (!dryRun && !confirm('Apply the APPROVED retention policies now? Eligible records are deleted or anonymised and cannot be brought back.')) return
    try { const r = await rpc<{ counts: Record<string, number>; errors: unknown[] }>('retention_apply', { p_dry_run: dryRun }); if (dryRun) setDry(r.counts); else toast(`Done: ${JSON.stringify(r.counts)}`); data.reload() } catch (e) { toast(errMsg(e)) }
  }
  return (
    <div className="priv">
      <h1 className="t-title">Privacy &amp; retention</h1>
      <p className="notice">Proposed periods for review — not legal advice and not, by themselves, POPIA compliance. Before approving any policy, VYBE’s Information Officer and a South African legal adviser should confirm the purpose, lawful basis, period, exceptions (disputes, chargebacks, tax, litigation holds), processor contracts and backup handling for each category. Records under a legal hold, or linked to an open investigation, are never removed.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void run(true)}>Dry run (count only)</button>
        <button className="btn ghost" onClick={() => void run(false)}>Apply approved policies now</button>
        <span className="t-meta">Approved policies also run daily at 02:41 UTC.</span>
      </div>
      <div className="inv-table-wrap"><table className="ds-table inv-table">
        <thead><tr><th scope="col">Category</th><th scope="col">Purpose</th><th scope="col">Clock starts</th><th scope="col">Period</th><th scope="col">At the end</th><th scope="col">Status</th><th scope="col">Dry run</th><th scope="col"><span className="sr-only">Change</span></th></tr></thead>
        <tbody>{d.policies.map(p => <PolicyRow key={p.category} p={p} dry={dry?.[p.category]} onDone={data.reload} />)}</tbody>
      </table></div>
      <Holds holds={d.holds} onDone={data.reload} />
      <Suppress />
      <section><h2 className="t-section">Recent runs</h2>
        <ul className="list" style={{ listStyle: 'none', padding: 0 }}>{d.runs.map(r => <li key={r.id} className="item t-meta">#{r.id} · {new Date(r.started_at).toLocaleString()} · {r.dry_run ? 'dry run' : 'applied'} · {r.status} · {Object.entries(r.counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'nothing'}{r.errors.length ? ` · errors: ${r.errors.map(e => e.category).join(', ')}` : ''}</li>)}</ul>
      </section>
    </div>
  )
}

function PolicyRow({ p, dry, onDone }: { p: Policy; dry?: number; onDone: () => void }) {
  const [edit, setEdit] = useState(false)
  const [period, setPeriod] = useState(p.period ?? ''); const [action, setAction] = useState(p.action); const [ref, setRef] = useState(p.approval_reference); const [note, setNote] = useState('')
  const save = async (approve: boolean) => {
    try { await rpc('admin_set_retention_policy', { p_category: p.category, p_period: period || null, p_action: action, p_approved: approve, p_reference: ref, p_note: note }); toast(approve ? 'Approved and recorded' : 'Saved as a proposal'); setEdit(false); onDone() } catch (e) { toast(errMsg(e)) }
  }
  return (
    <>
      <tr>
        <th scope="row">{p.category.replace(/_/g, ' ')}<span className="t-meta" style={{ display: 'block', fontWeight: 400 }}>{p.description}</span></th>
        <td>{p.purpose}</td><td>{p.basis === 'event_end' ? 'event ends' : p.basis === 'closed' ? 'record closed' : 'record created'}</td>
        <td>{p.period ?? '— (needs a legal schedule)'}</td><td>{p.action}{p.enforceable ? '' : ' (manual)'}</td>
        <td>{p.approved ? `Approved v${p.version}` : 'Proposal'}</td><td>{dry ?? ''}</td>
        <td><button className="btn ghost sm" onClick={() => setEdit(e => !e)}>{edit ? 'Close' : 'Change'}</button></td>
      </tr>
      {edit && <tr><td colSpan={8}>
        <div className="row ds-row">
          <Field id={`rp-${p.category}`} label="Period" hint="e.g. 12 months, 90 days"><input id={`rp-${p.category}`} className="input" value={period} onChange={e => setPeriod(e.target.value)} /></Field>
          <Field id={`ra-${p.category}`} label="At the end"><select id={`ra-${p.category}`} className="input" value={action} onChange={e => setAction(e.target.value)}><option value="delete">delete</option><option value="anonymise">anonymise</option><option value="keep">keep</option></select></Field>
          <Field id={`rr-${p.category}`} label="Approval reference" hint="Who approved, when, which document"><input id={`rr-${p.category}`} className="input" value={ref} onChange={e => setRef(e.target.value)} /></Field>
          <Field id={`rn-${p.category}`} label="Note"><input id={`rn-${p.category}`} className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
          <button className="btn sm" onClick={() => void save(false)}>Save as proposal</button>
          <button className="btn primary sm" disabled={ref.trim().length < 5} onClick={() => void save(true)}>Approve</button>
        </div>
      </td></tr>}
    </>
  )
}

function Holds({ holds, onDone }: { holds: Hold[]; onDone: () => void }) {
  const [type, setType] = useState('event'); const [id, setId] = useState(''); const [reason, setReason] = useState('')
  const act = async (args: Record<string, unknown>, done: string) => { try { await rpc('admin_legal_hold', args); toast(done); setId(''); setReason(''); onDone() } catch (e) { toast(errMsg(e)) } }
  return (
    <section><h2 className="t-section">Legal holds</h2>
      <p className="t-meta">A hold stops retention for an event, ticket, order or person (disputes, chargebacks, fraud investigations, litigation).</p>
      <ul className="ds-list">{holds.map(h => <li key={h.id}><span className="grow">{h.scope_type} {h.scope_id.slice(0, 8)}… · {h.reason} <span className="t-meta">since {new Date(h.placed_at).toLocaleDateString()}</span></span>
        <button className="btn ghost sm" onClick={() => { const r = prompt('Why is this hold released?'); if (r) void act({ p_scope_type: h.scope_type, p_scope_id: h.scope_id, p_reason: r, p_release_id: h.id }, 'Hold released') }}>Release</button></li>)}</ul>
      <div className="row ds-row">
        <Field id="lh-type" label="Applies to"><select id="lh-type" className="input" value={type} onChange={e => setType(e.target.value)}><option value="event">Event</option><option value="ticket">Ticket</option><option value="order">Order</option><option value="user">Person</option></select></Field>
        <Field id="lh-id" label="Id"><input id="lh-id" className="input" value={id} onChange={e => setId(e.target.value)} /></Field>
        <Field id="lh-why" label="Reason"><input id="lh-why" className="input" value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <button className="btn sm" disabled={!/^[0-9a-f-]{36}$/i.test(id) || reason.trim().length < 5} onClick={() => void act({ p_scope_type: type, p_scope_id: id.trim(), p_reason: reason.trim() }, 'Hold placed')}>Place hold</button>
      </div>
    </section>
  )
}

function Suppress() {
  const [email, setEmail] = useState(''); const [reason, setReason] = useState('bounce'); const [note, setNote] = useState('')
  const go = async (on: boolean) => { try { await rpc('admin_email_suppress', { p_email: email, p_reason: reason, p_note: note, p_on: on }); toast(on ? 'Address suppressed for ticket mail' : 'Address allowed again'); setEmail(''); setNote('') } catch (e) { toast(errMsg(e)) } }
  return (
    <section><h2 className="t-section">Ticket email suppressions</h2>
      <p className="t-meta">VYBE sends over SMTP, which only confirms the provider accepted a message. Record bounces and complaints reported by the provider here; queued ticket mail to that address is skipped (tickets stay in the app).</p>
      <div className="row ds-row">
        <Field id="sp-email" label="Email address"><input id="sp-email" type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field id="sp-why" label="Reason"><select id="sp-why" className="input" value={reason} onChange={e => setReason(e.target.value)}><option value="bounce">bounce</option><option value="complaint">complaint</option><option value="unsubscribe">unsubscribe</option><option value="manual">manual</option></select></Field>
        <Field id="sp-note" label="Note"><input id="sp-note" className="input" value={note} onChange={e => setNote(e.target.value)} /></Field>
        <button className="btn sm" disabled={!email.includes('@')} onClick={() => void go(true)}>Suppress</button>
        <button className="btn ghost sm" disabled={!email.includes('@')} onClick={() => void go(false)}>Allow again</button>
      </div>
    </section>
  )
}
