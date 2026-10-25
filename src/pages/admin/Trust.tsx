import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { useAsync } from '../../lib/hooks'
import { supabase } from '../../lib/supabase'
import { formatEventTime } from '../../lib/format'
import { money } from '../../lib/tickets'
import { modelScenario, priceOrder, type FeeTerms } from '../../lib/pricing'
import {
  EVIDENCE_LABEL, REVIEW_LABEL, createFeePolicy, decideEvidence, exceptions, feePolicies, loadReview, paymentNotifications, reconcile, resolveException,
  reviewEventSales, reviewQueue, setLineupStatus, ticketFinance, type ExceptionCase, type QueueItem, type SalesReview,
} from '../../lib/trust'
import { Empty, ErrorState, Field, Spinner, Tabs, errMsg, toast, useSigned } from '../../ui'

type Tab = 'review' | 'terms' | 'money'

/**
 * Admin → Tickets & Trust. Event review (evidence, lineup, decisions), commercial terms (versioned, with a calculator),
 * and money (journal-based figures, reconciliation cases, payment notifications). Every action is a database function
 * that re-checks the admin and records who did what; reviewers cannot act on events they belong to.
 */
export default function AdminTrust() {
  const [params, setParams] = useSearchParams()
  const tab = (['review', 'terms', 'money'].includes(params.get('tab') ?? '') ? params.get('tab') : 'review') as Tab
  return (
    <div className="stack">
      <h1 className="t-title">Tickets &amp; Trust</h1>
      <Tabs value={tab} onChange={t => setParams({ tab: t }, { replace: true })} items={[{ id: 'review', label: 'Event review' }, { id: 'terms', label: 'Terms' }, { id: 'money', label: 'Money & reconciliation' }]} />
      {tab === 'review' && <Review />}
      {tab === 'terms' && <Terms />}
      {tab === 'money' && <Money />}
    </div>
  )
}

/* ------------------------------------------------------------------ review */
const QUEUES: { id: string; label: string; statuses: SalesReview[] }[] = [
  { id: 'open', label: 'Waiting', statuses: ['submitted', 'under_review'] }, { id: 'suspended', label: 'Suspended', statuses: ['suspended'] },
  { id: 'approved', label: 'Approved', statuses: ['approved'] }, { id: 'rejected', label: 'Changes requested', statuses: ['rejected'] },
]
function Review() {
  const [q, setQ] = useState('open')
  const [open, setOpen] = useState<QueueItem | null>(null)
  const queue = QUEUES.find(x => x.id === q)!
  const list = useAsync(() => reviewQueue(queue.statuses), [q])
  if (open) return <ReviewDetail item={open} onBack={() => { setOpen(null); list.reload() }} />
  return (
    <section>
      <div className="chips" role="group" aria-label="Queue" style={{ marginBottom: 12 }}>{QUEUES.map(x => <button key={x.id} className="chip" aria-pressed={q === x.id} onClick={() => setQ(x.id)}>{x.label}</button>)}</div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data === null ? <p className="notice">Event review needs migration 27.</p>
        : !list.data.length ? <Empty title="Nothing here">{q === 'open' ? 'No events are waiting for review.' : 'No events in this list.'}</Empty> : (
          <div className="list">{list.data.map(e => (
            <button key={e.id} className="item row link" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setOpen(e)}>
              <span className="grow"><span className="t-name">{e.title}</span><span className="t-meta" style={{ display: 'block' }}>{formatEventTime(e.starts_at, e.timezone)} · {e.organizations?.name ?? `@${e.profiles?.username}`}</span></span>
              <span className={`trust-chip s-${e.sales_review}`}>{REVIEW_LABEL[e.sales_review]}</span>
            </button>))}</div>
        )}
    </section>
  )
}

function EvidenceFile({ path }: { path: string }) {
  const url = useSigned(path)
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="t-meta">Open attachment <ExternalLink size={12} aria-hidden /></a> : <span className="t-meta">Loading attachment…</span>
}

function ReviewDetail({ item, onBack }: { item: QueueItem; onBack: () => void }) {
  const st = useAsync(() => loadReview(item.id), [item.id])
  const lineup = useAsync(async () => {
    const { data, error } = await supabase.from('event_lineup').select('id,name,role,status,status_note').eq('event_id', item.id).order('sort')
    if (error) throw error
    return (data ?? []) as { id: string; name: string; role: string; status: string; status_note: string }[]
  }, [item.id])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>, ok: string) => { if (busy) return; setBusy(true); try { await fn(); toast(ok); st.reload(); lineup.reload() } catch (e) { toast(errMsg(e)) } finally { setBusy(false) } }
  const s = st.data?.status ?? item.sales_review
  const moves: { to: SalesReview; label: string; needsReason?: boolean; kind?: string }[] =
    s === 'submitted' ? [{ to: 'under_review', label: 'Start review' }, { to: 'approved', label: 'Approve sales', kind: 'primary' }, { to: 'rejected', label: 'Request changes', needsReason: true, kind: 'danger' }]
    : s === 'under_review' ? [{ to: 'approved', label: 'Approve sales', kind: 'primary' }, { to: 'rejected', label: 'Request changes', needsReason: true, kind: 'danger' }]
    : s === 'approved' ? [{ to: 'suspended', label: 'Suspend sales', needsReason: true, kind: 'danger' }]
    : s === 'suspended' ? [{ to: 'approved', label: 'Reinstate sales', kind: 'primary' }, { to: 'rejected', label: 'Reject', needsReason: true, kind: 'danger' }] : []
  return (
    <section className="stack">
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={onBack}>← Back to the queue</button>
      <div className="row between"><div><h2 className="t-section">{item.title}</h2><p className="t-meta">{formatEventTime(item.starts_at, item.timezone)} · {item.organizations ? <>Organisation <b>{item.organizations.name}</b></> : <>Host <b>@{item.profiles?.username}</b></>} · <Link to={`/app/plans/${item.id}`}>Open event</Link></p></div>
        <span className={`trust-chip s-${s}`}>{REVIEW_LABEL[s]}</span></div>
      {st.loading && !st.data ? <Spinner /> : st.error ? <ErrorState message={st.error} onRetry={st.reload} /> : st.data && (
        <>
          {st.data.note && <p className="notice">Organiser note / last decision: {st.data.note}</p>}
          <div className="card">
            <h3 className="t-name" style={{ marginBottom: 6 }}>Evidence</h3>
            {!st.data.evidence.length ? <p className="t-meta">None submitted.</p> : st.data.evidence.map(e => (
              <div key={e.id} className="item">
                <div className="row between"><b>{EVIDENCE_LABEL[e.kind]}</b><span className="tag">{e.status}</span></div>
                {e.note && <p style={{ whiteSpace: 'pre-wrap' }}>{e.note}</p>}{e.file_path && <EvidenceFile path={e.file_path} />}
                {e.status === 'pending' && <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <button className="btn sm" disabled={busy} onClick={() => act(() => decideEvidence(e.id, 'approved', reason), 'Evidence accepted')}>Accept</button>
                  <button className="btn sm danger" disabled={busy} onClick={() => act(() => decideEvidence(e.id, 'rejected', reason), 'Evidence rejected')}>Reject (uses the reason below)</button></div>}
              </div>))}
          </div>
          <div className="card">
            <h3 className="t-name" style={{ marginBottom: 6 }}>Lineup</h3>
            <p className="t-meta" style={{ marginBottom: 6 }}>Confirm an act only after checking with a trusted source (the artist’s verified page, their agent or management). Write the source in the reason box.</p>
            {lineup.data?.length ? lineup.data.map(l => (
              <div key={l.id} className="item row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <span style={{ flex: '1 1 100%' }}><b>{l.name}</b> <span className="t-meta">{l.role} · {l.status}{l.status_note ? ` · ${l.status_note}` : ''}</span></span>
                {(['confirmed', 'disputed', 'cancelled', 'pending'] as const).filter(x => x !== l.status).map(x => <button key={x} className="btn sm" disabled={busy} onClick={() => act(() => setLineupStatus(l.id, x, reason), `Marked ${x}`)}>{x}</button>)}
              </div>)) : <p className="t-meta">No lineup listed.</p>}
          </div>
          {st.data.terms && <p className="t-meta">Terms that apply: {st.data.terms.name} ({st.data.terms.scope}).</p>}
          <Field id="rv-reason" label="Reason / source (shown to the organiser for refusals; recorded for every decision)"><textarea id="rv-reason" className="textarea" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></Field>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{moves.map(m => (
            <button key={m.to} className={`btn${m.kind ? ` ${m.kind}` : ''}`} disabled={busy || (m.needsReason && !reason.trim())} onClick={() => act(() => reviewEventSales(item.id, m.to, reason), `${REVIEW_LABEL[m.to]}`)}>{m.label}</button>))}</div>
          {st.data.decisions.length > 0 && <details><summary className="t-meta">Decision history</summary>{st.data.decisions.map(d => <p key={d.id} className="t-meta">{new Date(d.created_at).toLocaleString()} · {d.from_status} → {d.to_status}{d.reason ? ` · ${d.reason}` : ''}</p>)}</details>}
        </>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ terms */
const EMPTY: FeeTerms = { commission_bps: 500, commission_fixed_cents: 0, commission_per_ticket_cents: 0, buyer_fee_enabled: false, buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 }
const rands = (cents: number) => (cents / 100).toFixed(2)
const toCents = (s: string) => Math.max(0, Math.round((parseFloat(s) || 0) * 100))

function Terms() {
  const list = useAsync(feePolicies, [])
  const [t, setT] = useState<FeeTerms>(EMPTY)
  const [scope, setScope] = useState<'platform' | 'organization' | 'event'>('platform')
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [starts, setStarts] = useState('')
  const [sc, setSc] = useState({ price: '250', tickets: '400', orders: '200', refund: '3', procBps: '350', procFixed: '200' })
  const num = (k: keyof FeeTerms, v: string) => setT(x => ({ ...x, [k]: Math.max(0, parseInt(v.replace(/\D/g, '') || '0', 10)) }))
  const model = useMemo(() => {
    try {
      return modelScenario({ terms: t, price_cents: toCents(sc.price), tickets: parseInt(sc.tickets, 10) || 0, orders: Math.max(1, parseInt(sc.orders, 10) || 1),
        refund_rate_bps: Math.round((parseFloat(sc.refund) || 0) * 100), processing_bps: parseInt(sc.procBps, 10) || 0, processing_fixed_cents: toCents(sc.procFixed) })
    } catch { return null }
  }, [t, sc])
  const save = async () => {
    try {
      await createFeePolicy({ ...t, scope, name, note, ...(scope === 'organization' ? { organization_id: target } : scope === 'event' ? { event_id: target } : {}), ...(starts ? { effective_from: new Date(starts).toISOString() } : {}) })
      toast('New terms saved. Existing orders keep the terms they were sold under.'); setNote(''); setName(''); list.reload()
    } catch (e) { toast(errMsg(e)) }
  }
  const one = priceOrder(t, toCents(sc.price), 1)
  return (
    <div className="stack">
      <section className="card">
        <h2 className="t-section" style={{ marginBottom: 6 }}>Terms in force and history</h2>
        {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data === null ? <p className="notice">Terms need migration 27.</p> : (
          <div className="list">{list.data.map(p => (
            <div key={p.id} className="item"><div className="row between"><b>{p.name}</b><span className="tag">{p.retired_at && new Date(p.retired_at) <= new Date() ? 'retired' : new Date(p.effective_from) > new Date() ? 'scheduled' : 'in force'}</span></div>
              <p className="t-meta">{p.scope}{p.organization_id ? ` · org ${p.organization_id.slice(0, 8)}` : ''}{p.event_id ? ` · event ${p.event_id.slice(0, 8)}` : ''} · from {new Date(p.effective_from).toLocaleString()}{p.retired_at ? ` to ${new Date(p.retired_at).toLocaleString()}` : ''}</p>
              <p className="t-meta">Commission {p.commission_bps / 100} %{p.commission_fixed_cents ? ` + ${money(p.commission_fixed_cents)}/order` : ''}{p.commission_per_ticket_cents ? ` + ${money(p.commission_per_ticket_cents)}/ticket` : ''} · buyer fee {p.buyer_fee_enabled ? `${p.buyer_fee_bps / 100} %${p.buyer_fee_fixed_cents ? ` + ${money(p.buyer_fee_fixed_cents)}/order` : ''}${p.buyer_fee_per_ticket_cents ? ` + ${money(p.buyer_fee_per_ticket_cents)}/ticket` : ''}` : 'off'}</p>
              {p.note && <p className="t-meta">{p.note}</p>}</div>))}</div>
        )}
      </section>
      <section className="card">
        <h2 className="t-section" style={{ marginBottom: 6 }}>New terms</h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>Commission is taken from the ticket price the buyer actually paid (after any discount, excluding the buyer fee). Buyer fees stay off unless reviewed for consumer-law disclosure. Amounts are VAT-inclusive when VYBE is VAT-registered.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Field id="ft-scope" label="Applies to"><select id="ft-scope" className="select" value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="platform">Everyone (platform default)</option><option value="organization">One organisation (contract)</option><option value="event">One event</option></select></Field>
          {scope !== 'platform' && <div className="grow"><Field id="ft-target" label={scope === 'organization' ? 'Organisation ID' : 'Event ID'}><input id="ft-target" className="input" value={target} onChange={e => setTarget(e.target.value.trim())} /></Field></div>}
        </div>
        <Field id="ft-name" label="Name"><input id="ft-name" className="input" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Standard 5 % organiser commission" /></Field>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Field id="ft-cb" label="Commission (basis points)" hint={`${t.commission_bps / 100} %`}><input id="ft-cb" className="input" inputMode="numeric" value={t.commission_bps} onChange={e => num('commission_bps', e.target.value)} /></Field>
          <Field id="ft-cf" label="+ per order (cents)"><input id="ft-cf" className="input" inputMode="numeric" value={t.commission_fixed_cents} onChange={e => num('commission_fixed_cents', e.target.value)} /></Field>
          <Field id="ft-ct" label="+ per ticket (cents)"><input id="ft-ct" className="input" inputMode="numeric" value={t.commission_per_ticket_cents} onChange={e => num('commission_per_ticket_cents', e.target.value)} /></Field>
        </div>
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={t.buyer_fee_enabled} onChange={e => setT(x => ({ ...x, buyer_fee_enabled: e.target.checked, ...(e.target.checked ? {} : { buyer_fee_bps: 0, buyer_fee_fixed_cents: 0, buyer_fee_per_ticket_cents: 0 }) }))} /> <span>Buyers pay a service fee on top</span></label>
        {t.buyer_fee_enabled && <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Field id="ft-bb" label="Buyer fee (basis points)"><input id="ft-bb" className="input" inputMode="numeric" value={t.buyer_fee_bps} onChange={e => num('buyer_fee_bps', e.target.value)} /></Field>
          <Field id="ft-bf" label="+ per order (cents)"><input id="ft-bf" className="input" inputMode="numeric" value={t.buyer_fee_fixed_cents} onChange={e => num('buyer_fee_fixed_cents', e.target.value)} /></Field>
          <Field id="ft-bt" label="+ per ticket (cents)"><input id="ft-bt" className="input" inputMode="numeric" value={t.buyer_fee_per_ticket_cents} onChange={e => num('buyer_fee_per_ticket_cents', e.target.value)} /></Field></div>}
        <Field id="ft-start" label="Starts (blank = now)"><input id="ft-start" type="datetime-local" className="input" value={starts} onChange={e => setStarts(e.target.value)} /></Field>
        <Field id="ft-note" label="Why (required, recorded)"><input id="ft-note" className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Board decision 2026-11-01; contract ref" /></Field>
        <p className="t-meta">A {money(toCents(sc.price))} ticket: buyer pays {money(one.total_cents)}, organiser receives {money(one.organizer_net_cents)}, VYBE keeps {money(one.commission_cents + one.buyer_fee_cents)} before payment processing.</p>
        <button className="btn primary" disabled={!note.trim() || (scope !== 'platform' && !target)} onClick={() => void save()}>Save new terms</button>
      </section>
      <section className="card">
        <h2 className="t-section" style={{ marginBottom: 6 }}>Scenario calculator <span className="tag">Estimate</span></h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>For planning only. Processing costs here are your assumption, not a provider quote; refunds are assumed to return the ticket price and its commission.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {([['price', 'Ticket price (R)'], ['tickets', 'Tickets sold'], ['orders', 'Orders'], ['refund', 'Refund rate (%)'], ['procBps', 'Assumed processing (bps)'], ['procFixed', 'Assumed processing per order (R)']] as const).map(([k, l]) =>
            <div key={k} style={{ width: 150 }}><Field id={`sc-${k}`} label={l}><input id={`sc-${k}`} className="input" inputMode="decimal" value={sc[k]} onChange={e => setSc(x => ({ ...x, [k]: e.target.value }))} /></Field></div>)}
        </div>
        {model && <dl className="calc">
          <dt>Gross ticket sales</dt><dd>R {rands(model.gross_ticket_sales_cents)}</dd>
          <dt>Collected from buyers</dt><dd>R {rands(model.collected_from_buyers_cents)}</dd>
          <dt>Refunds</dt><dd>R {rands(model.refunds_cents)}</dd>
          <dt>Owed to the organiser</dt><dd>R {rands(model.organiser_payable_cents)}</dd>
          <dt>VYBE revenue (ex VAT)</dt><dd>R {rands(model.platform_revenue_ex_vat_cents)}</dd>
          <dt>Assumed processing cost</dt><dd>R {rands(model.assumed_processing_cost_cents)}</dd>
          <dt><b>Net contribution (estimate)</b></dt><dd><b>R {rands(model.net_platform_contribution_cents)}</b></dd>
        </dl>}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ money */
function Money() {
  const [days, setDays] = useState(30)
  const range = useMemo(() => ({ from: new Date(Date.now() - days * 86400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }), [days])
  const fin = useAsync(() => ticketFinance(range.from, range.to), [range.from])
  const [which, setWhich] = useState<'open' | 'resolved' | 'dismissed'>('open')
  const cases = useAsync(() => exceptions(which), [which])
  const notes = useAsync(paymentNotifications, [])
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { const r = await reconcile(); toast(`${r.new_exceptions} new case(s); ${r.open_exceptions} open; ${r.expired_orders} lapsed holds released`); cases.reload(); fin.reload() } catch (e) { toast(errMsg(e)) } finally { setBusy(false) } }
  const f = fin.data
  return (
    <div className="stack">
      <section className="card">
        <div className="row between"><h2 className="t-section">Ticketing money</h2>
          <select className="select" style={{ width: 'auto' }} value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">{[7, 30, 90, 365].map(d => <option key={d} value={d}>Last {d} days</option>)}</select></div>
        {fin.loading && !f ? <Spinner /> : fin.error ? <ErrorState message={fin.error} onRetry={fin.reload} /> : f && (
          <>
            <p className="t-meta" style={{ margin: '6px 0 10px' }}>{f.basis}</p>
            <dl className="calc">
              <dt>Collected (provider-confirmed)</dt><dd>{money(f.collected_cents)}</dd>
              <dt>Gross ticket sales</dt><dd>{money(f.gross_ticket_sales_cents)}</dd>
              <dt>Commission revenue (ex VAT)</dt><dd>{money(f.commission_revenue_cents)}</dd>
              <dt>Buyer fee revenue (ex VAT)</dt><dd>{money(f.buyer_fee_revenue_cents)}</dd>
              <dt>VAT on VYBE’s charges</dt><dd>{money(f.vat_on_platform_charges_cents)}</dd>
              <dt>Refunds paid</dt><dd>{money(f.refunds_paid_cents)}</dd>
              <dt>Chargebacks</dt><dd>{money(f.chargebacks_cents)} <span className="t-meta">(VYBE’s loss {money(f.chargeback_losses_cents)})</span></dd>
              <dt>Payouts completed</dt><dd>{money(f.payouts_completed_cents)}</dd>
              <dt><b>Net platform contribution</b></dt><dd><b>{money(f.net_platform_contribution_cents)}</b></dd>
            </dl>
            <p className="t-meta" style={{ marginTop: 6 }}>Payment processing: {f.processing_costs}</p>
            <h3 className="t-name" style={{ margin: '12px 0 4px' }}>Right now</h3>
            <dl className="calc">
              <dt>Held at providers / bank</dt><dd>{money(f.balances.cash_held_cents)}</dd>
              <dt>Owed to organisers</dt><dd>{money(f.balances.organizer_payable_cents)}</dd>
              <dt>Owed back to buyers (outside organiser sales)</dt><dd>{money(f.balances.refunds_owed_cents)}</dd>
              <dt>Refunds requested or in progress</dt><dd>{money(f.open_refund_obligations_cents)}</dd>
              <dt>VAT payable</dt><dd>{money(f.balances.vat_payable_cents)}</dd>
            </dl>
          </>
        )}
      </section>
      <section className="card">
        <div className="row between"><h2 className="t-section">Reconciliation cases</h2><button className="btn sm" disabled={busy} onClick={() => void run()}><RefreshCw size={14} aria-hidden /> Run checks now</button></div>
        <p className="t-meta" style={{ margin: '4px 0 8px' }}>Checks: journal balance, every paid order has its sale entry and exactly its tickets, organiser balances agree in both ledgers, refunds are not stuck, payouts carry a bank reference. Payment mismatches and late payments open cases automatically. pg_cron is not installed, so run this daily (it also releases lapsed checkout holds).</p>
        <div className="chips" role="group" aria-label="Status" style={{ marginBottom: 8 }}>{(['open', 'resolved', 'dismissed'] as const).map(s => <button key={s} className="chip" aria-pressed={which === s} onClick={() => setWhich(s)}>{s}</button>)}</div>
        {cases.loading && !cases.data ? <Spinner /> : cases.error ? <ErrorState message={cases.error} onRetry={cases.reload} /> : !cases.data?.length ? <p className="t-meta">{cases.data === null ? 'Needs migration 27.' : 'None.'}</p>
          : cases.data.map(c => <CaseRow key={c.id} c={c} onDone={cases.reload} />)}
      </section>
      <section className="card">
        <h2 className="t-section" style={{ marginBottom: 6 }}>Payment notifications (latest 50)</h2>
        {notes.loading && !notes.data ? <Spinner /> : !notes.data?.length ? <p className="t-meta">{notes.data === null ? 'Needs migration 27.' : 'None received yet.'}</p> : (
          <div className="list">{notes.data.map(n => (
            <div key={n.id} className="item row"><span className="grow"><b>{n.provider}</b> {n.reported_status} · {n.amount_cents != null ? money(n.amount_cents) : '—'} · <span className="t-meta">{n.order_ref.slice(0, 8)} · txn {n.provider_txn_id}{n.times_seen > 1 ? ` · seen ${n.times_seen}×` : ''}</span></span>
              <span className={`tag${n.outcome === 'fulfilled' || n.outcome === 'closed' ? '' : ' muted'}`}>{n.outcome}</span></div>))}</div>
        )}
      </section>
    </div>
  )
}

function CaseRow({ c, onDone }: { c: ExceptionCase; onDone: () => void }) {
  const [text, setText] = useState('')
  const done = async (status: 'resolved' | 'dismissed') => { try { await resolveException(c.id, status, text); toast('Recorded'); onDone() } catch (e) { toast(errMsg(e)) } }
  return (
    <div className="item">
      <div className="row between"><b>{c.kind.replace(/_/g, ' ')}</b><span className={`tag sev-${c.severity}`}>{c.severity}</span></div>
      <p className="t-meta">{new Date(c.created_at).toLocaleString()}{c.order_id ? ` · order ${c.order_id.slice(0, 8)}` : ''}{c.refund_id ? ` · refund ${c.refund_id.slice(0, 8)}` : ''}{c.payout_id ? ` · payout ${c.payout_id.slice(0, 8)}` : ''}</p>
      {Object.keys(c.detail ?? {}).length > 0 && <pre className="t-meta" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{JSON.stringify(c.detail, null, 1)}</pre>}
      {c.status === 'open' ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input className="input grow" style={{ minWidth: 200 }} aria-label="What was done" placeholder="What was done (required)" value={text} onChange={e => setText(e.target.value)} />
          <button className="btn sm" disabled={text.trim().length < 5} onClick={() => void done('resolved')}>Resolved</button>
          <button className="btn sm ghost" disabled={text.trim().length < 5} onClick={() => void done('dismissed')}>Not an issue</button>
        </div>) : <p className="t-meta">{c.status}: {c.resolution}</p>}
    </div>
  )
}
