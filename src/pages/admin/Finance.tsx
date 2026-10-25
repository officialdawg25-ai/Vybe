import { Link } from 'react-router-dom'
import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { callFunction } from '../../lib/functions'
import { REFUND_LABEL, money, processRefund } from '../../lib/finance'
import { Empty, ErrorState, Field, Sheet, Spinner, Tabs, errMsg, toast } from '../../ui'

type Tab = 'overview' | 'refunds' | 'disputes' | 'payouts' | 'accounts' | 'settings'
const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await supabase.rpc(fn, args); if (error) throw new Error(error.message); return data }

/** Finance console (administrators only; every function re-checks the role in the database). */
export default function AdminFinance() {
  const [tab, setTab] = useState<Tab>('overview')
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Finance</h1>
      <p className="t-meta" style={{ marginBottom: 12 }}>Money movements are recorded in an append-only ledger. Every action here is written to the audit log.</p>
      <Tabs value={tab} onChange={setTab} items={[{ id: 'overview', label: 'Overview' }, { id: 'refunds', label: 'Refunds' }, { id: 'disputes', label: 'Chargebacks' }, { id: 'payouts', label: 'Payouts' }, { id: 'accounts', label: 'Bank accounts' }, { id: 'settings', label: 'Fees & VAT' }]} />
      {tab === 'overview' && <Overview />}{tab === 'refunds' && <Refunds />}{tab === 'disputes' && <Disputes />}{tab === 'payouts' && <Payouts />}{tab === 'accounts' && <Accounts />}{tab === 'settings' && <Settings />}
    </>
  )
}

function Overview() {
  const [days, setDays] = useState(30)
  const s = useAsync(async () => rpc('admin_finance_summary', { p_from: new Date(Date.now() - days * 86400_000).toISOString(), p_to: new Date().toISOString() }) as Promise<Record<string, number | Record<string, number>>>, [days])
  if (s.loading && !s.data) return <Spinner />
  if (s.error) return <ErrorState message={s.error} onRetry={s.reload} />
  const x = s.data!
  const n = (k: string) => Number(x[k] ?? 0)
  return (
    <div className="stack">
      <label className="t-meta row" style={{ gap: 6 }}>Period <select className="select" style={{ width: 'auto', minHeight: 36 }} value={days} onChange={e => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map(d => <option key={d} value={d}>Last {d} days</option>)}</select></label>
      <div className="fin-cards">
        <div className="card"><div className="t-meta">Ticket sales (organizers)</div><div className="fin-big">{money(n('ticket_sales_cents'))}</div><div className="t-meta">{n('paid_orders')} paid orders</div></div>
        <div className="card"><div className="t-meta">Service fees (VYBE revenue)</div><div className="fin-big">{money(n('service_fees_cents'))}</div><div className="t-meta">of which VAT {money(n('service_fee_vat_cents'))}</div></div>
        <div className="card"><div className="t-meta">Refunded</div><div className="fin-big">{money(n('refunded_cents'))}</div><div className="t-meta">{Object.entries((x.by_provider ?? {}) as Record<string, number>).map(([k, v]) => `${k} ${money(Number(v))}`).join(' · ') || 'No payments in this period'}</div></div>
      </div>
      <div className="card"><h2 className="t-section">Needs attention</h2>
        <ul className="t-support" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>{n('open_refunds')} open refunds</li><li>{n('open_disputes')} open chargebacks</li><li>{n('payouts_awaiting')} payouts awaiting action</li><li>{n('accounts_to_verify')} bank accounts to verify</li>
        </ul></div>
    </div>
  )
}

interface RefundR { id: string; status: string; kind: string; ticket_amount_cents: number; fee_amount_cents: number; reason: string; error: string | null; provider: string | null; orders: { id: string; events: { title: string } | null } | null }
function Refunds() {
  const [ref, setRef] = useState<{ id: string } | null>(null)
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('refunds').select('id,status,kind,ticket_amount_cents,fee_amount_cents,reason,error,provider,orders(id,events(title))').in('status', ['requested', 'approved', 'processing', 'manual_required', 'failed']).order('created_at').limit(100)
    if (error) throw error
    return (data ?? []) as unknown as RefundR[]
  }, [])
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); list.reload() } catch (e) { toast(errMsg(e)) } }
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data?.length) return <Empty title="No open refunds" />
  return (
    <div className="list">{list.data.map(r => (
      <div key={r.id} className="item stack" style={{ gap: 4 }}>
        <div className="row between"><span className="t-name">{r.orders?.events?.title}</span><span className="tag">{REFUND_LABEL[r.status] ?? r.status}</span></div>
        <div className="t-meta">{money(Number(r.ticket_amount_cents) + Number(r.fee_amount_cents))} · {r.kind.replace('_', ' ')} · order {r.orders?.id.slice(0, 8)}</div>
        {r.error && <p className="t-meta">{r.error}</p>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {r.status === 'requested' && <><button className="btn sm primary" onClick={() => run(async () => { await rpc('decide_refund', { p_refund: r.id, p_approve: true, p_note: '' }); await processRefund(r.id).catch(() => {}) }, 'Approved')}>Approve</button><button className="btn sm" onClick={() => run(() => rpc('decide_refund', { p_refund: r.id, p_approve: false, p_note: 'Declined by VYBE' }), 'Declined')}>Decline</button></>}
          {r.status === 'approved' && <button className="btn sm" onClick={() => run(() => processRefund(r.id), 'Sent')}>Process now</button>}
          {r.status === 'manual_required' && <button className="btn sm primary" onClick={() => setRef(r)}>Mark refunded…</button>}
        </div>
      </div>))}
      {ref && <ReferenceSheet title="Complete refund" label="Bank / provider reference" onClose={() => setRef(null)} onSave={async v => { await rpc('admin_complete_refund', { p_refund: ref.id, p_reference: v }); setRef(null); list.reload() }} />}
    </div>
  )
}

function ReferenceSheet({ title, label, onSave, onClose }: { title: string; label: string; onSave: (v: string) => Promise<void>; onClose: () => void }) {
  const [v, setV] = useState('')
  const [err, setErr] = useState('')
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="t-support" style={{ marginBottom: 8 }}>Only confirm after the money has actually moved.</p>
      <Field id="ref-v" label={label}><input id="ref-v" className="input" value={v} maxLength={120} onChange={e => setV(e.target.value)} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!v.trim()} onClick={async () => { try { await onSave(v.trim()) } catch (e) { setErr(errMsg(e)) } }}>Confirm</button></div>
    </Sheet>
  )
}

interface DisputeR { id: string; status: string; amount_cents: number; reason: string; order_id: string; created_at: string }
function Disputes() {
  const [order, setOrder] = useState(''), [amount, setAmount] = useState(''), [reason, setReason] = useState('')
  const list = useAsync(async () => { const { data, error } = await supabase.from('disputes').select('id,status,amount_cents,reason,order_id,created_at').order('created_at', { ascending: false }).limit(100); if (error) throw error; return (data ?? []) as DisputeR[] }, [])
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); list.reload() } catch (e) { toast(errMsg(e)) } }
  return (
    <div className="stack">
      <section className="card" aria-labelledby="od"><h2 id="od" className="t-section">Record a chargeback</h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>Neither gateway notifies us of chargebacks. When you are told about one, record it here: the buyer’s tickets are voided while it is open.</p>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="grow"><Field id="d-o" label="Order ID"><input id="d-o" className="input" value={order} onChange={e => setOrder(e.target.value.trim())} /></Field></div>
          <div style={{ width: 140 }}><Field id="d-a" label="Amount (R)"><input id="d-a" inputMode="decimal" className="input" value={amount} onChange={e => setAmount(e.target.value)} /></Field></div>
          <div className="grow"><Field id="d-r" label="Reason"><input id="d-r" className="input" value={reason} onChange={e => setReason(e.target.value)} /></Field></div>
          <button className="btn primary" style={{ marginBottom: 16 }} disabled={!order || !amount} onClick={() => run(async () => { await rpc('open_dispute', { p_order: order, p_amount: Math.round(parseFloat(amount) * 100), p_reason: reason }); setOrder(''); setAmount(''); setReason('') }, 'Chargeback recorded')}>Open</button>
        </div></section>
      {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.length ? <Empty title="No chargebacks" /> : (
        <div className="list">{list.data.map(d => (
          <div key={d.id} className="item row"><div className="grow"><div className="t-name">{money(d.amount_cents)} · {d.status}</div><div className="t-meta">order {d.order_id.slice(0, 8)} · {d.reason}</div></div>
            {d.status === 'open' && <><button className="btn sm" onClick={() => run(() => rpc('resolve_dispute', { p_dispute: d.id, p_outcome: 'won' }), 'Marked won — tickets restored')}>We won</button><button className="btn sm danger" onClick={() => confirm('Mark as lost? The organizer is debited and the buyer is blocked from purchases.') && run(() => rpc('resolve_dispute', { p_dispute: d.id, p_outcome: 'lost' }), 'Marked lost')}>We lost</button></>}</div>))}</div>
      )}
    </div>
  )
}

interface PayoutR { id: string; amount_cents: number; status: string; organization_id: string | null; user_id: string | null; created_at: string; bank_reference: string | null; organizations: { name: string } | null; profiles: { username: string } | null }
function Payouts() {
  const [paying, setPaying] = useState<PayoutR | null>(null)
  const [reveal, setReveal] = useState<Record<string, string> | null>(null)
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('payouts').select('id,amount_cents,status,organization_id,user_id,created_at,bank_reference,organizations(name),profiles:user_id(username)').order('created_at', { ascending: false }).limit(100)
    if (error) throw error
    return (data ?? []) as unknown as PayoutR[]
  }, [])
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); list.reload() } catch (e) { toast(errMsg(e)) } }
  const showBank = async (p: PayoutR) => {
    try {
      const acc = await supabase.from('payout_accounts').select('id').match(p.organization_id ? { organization_id: p.organization_id } : { user_id: p.user_id! }).maybeSingle()
      if (!acc.data) return toast('No payout account on file')
      setReveal(await callFunction<Record<string, string>>('payout-account', { action: 'reveal', account_id: acc.data.id }))
    } catch (e) { toast(errMsg(e)) }
  }
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data?.length) return <Empty title="No payouts yet" />
  return (
    <div className="list">{list.data.map(p => (
      <div key={p.id} className="item stack" style={{ gap: 4 }}>
        <div className="row between"><span className="t-name">{money(p.amount_cents)} → {p.organizations?.name ?? `@${p.profiles?.username}`}</span><span className="tag">{p.status}</span></div>
        <div className="t-meta">{new Date(p.created_at).toLocaleString()}{p.bank_reference ? ` · ref ${p.bank_reference}` : ''}</div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {p.status === 'requested' && <><button className="btn sm primary" onClick={() => run(() => rpc('admin_decide_payout', { p_payout: p.id, p_approve: true }), 'Approved')}>Approve</button><button className="btn sm" onClick={() => run(() => rpc('admin_decide_payout', { p_payout: p.id, p_approve: false, p_note: 'Rejected' }), 'Rejected')}>Reject</button></>}
          {p.status === 'approved' && <><button className="btn sm" onClick={() => showBank(p)}>View bank details</button><button className="btn sm primary" onClick={() => setPaying(p)}>Mark as paid…</button></>}
        </div>
      </div>))}
      {paying && <ReferenceSheet title={`Mark ${money(paying.amount_cents)} as paid`} label="Bank reference (EFT / batch id)" onClose={() => setPaying(null)} onSave={async v => { await rpc('admin_mark_payout_paid', { p_payout: paying.id, p_reference: v }); setPaying(null); list.reload() }} />}
      {reveal && <Sheet title="Bank details" onClose={() => setReveal(null)}><dl className="stack" style={{ gap: 6 }}>{Object.entries(reveal).map(([k, v]) => <div key={k}><dt className="t-meta">{k.replace('_', ' ')}</dt><dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>{v}</dd></div>)}</dl><p className="t-meta" style={{ marginTop: 8 }}>This view was recorded in the audit log.</p></Sheet>}
    </div>
  )
}

interface AccR { id: string; holder: string; bank: string; account_last4: string; status: string; organizations: { name: string } | null; profiles: { username: string } | null }
function Accounts() {
  const list = useAsync(async () => { const { data, error } = await supabase.from('payout_accounts').select('id,holder,bank,account_last4,status,organizations(name),profiles:user_id(username)').order('created_at', { ascending: false }).limit(100); if (error) throw error; return (data ?? []) as unknown as AccR[] }, [])
  const set = async (id: string, status: string) => { try { await rpc('admin_set_payout_account_status', { p_account: id, p_status: status }); toast(`Account ${status}`); list.reload() } catch (e) { toast(errMsg(e)) } }
  if (list.loading) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data?.length) return <Empty title="No bank accounts yet" />
  return (
    <>
      <p className="notice" style={{ marginBottom: 8 }}>Before verifying, check the account holder matches the organization’s registered name, and confirm by a small test deposit or the bank’s account-verification service.</p>
      <div className="list">{list.data.map(a => (
        <div key={a.id} className="item row"><div className="grow"><div className="t-name">{a.organizations?.name ?? `@${a.profiles?.username}`}</div><div className="t-meta">{a.holder} · {a.bank} ·••••{a.account_last4} · {a.status}</div></div>
          {a.status !== 'verified' && <button className="btn sm primary" onClick={() => set(a.id, 'verified')}>Verify</button>}{a.status === 'pending' && <button className="btn sm" onClick={() => set(a.id, 'rejected')}>Reject</button>}</div>))}</div>
    </>
  )
}

function Settings() {
  const cfg = useAsync(async () => rpc('admin_get_config', {}) as Promise<Record<string, string | number | boolean | null>>, [])
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null)
  const [adj, setAdj] = useState({ org: '', user: '', amount: '', note: '' })
  if (cfg.loading) return <Spinner />
  if (cfg.error) return <ErrorState message={cfg.error} onRetry={cfg.reload} />
  const c = cfg.data!
  const v = (k: string) => String((draft ?? {})[k] ?? c[k] ?? '')
  const set = (k: string, val: string | boolean) => setDraft(d => ({ ...(d ?? {}), [k]: val }))
  const num = (k: string) => (draft && k in draft ? parseInt(String(draft[k]), 10) : undefined)
  const save = async () => {
    try {
      const body: Record<string, unknown> = {}
      for (const k of ['vat_rate_bps', 'settlement_hold_days', 'payout_min_cents', 'buyer_refund_hours', 'hold_minutes', 'max_tickets_per_order', 'payout_dual_control_cents', 'payout_account_cooloff_hours']) { const n = num(k); if (n !== undefined && !Number.isNaN(n)) body[k] = n }
      if (draft && 'vat_registered' in draft) body.vat_registered = draft.vat_registered
      if (draft && 'require_sales_review' in draft) body.require_sales_review = draft.require_sales_review
      if (draft && 'vat_number' in draft) body.vat_number = draft.vat_number
      if (draft && 'legal_name' in draft) body.legal_name = draft.legal_name
      await rpc('admin_set_config', { p: body }); toast('Saved'); setDraft(null); cfg.reload()
    } catch (e) { toast(errMsg(e)) }
  }
  const field = (k: string, label: string, hint?: string) => <Field id={`c-${k}`} label={label} hint={hint}><input id={`c-${k}`} className="input" inputMode="numeric" value={v(k)} onChange={e => set(k, e.target.value.replace(/\D/g, ''))} /></Field>
  return (
    <div className="stack">
      <section className="card" aria-labelledby="fees">
        <h2 id="fees" className="t-section" style={{ marginBottom: 8 }}>Ticketing rules</h2>
        <p className="notice" style={{ marginBottom: 12 }}>Commission and buyer fees are versioned terms now: <Link to="/admin/trust?tab=terms">Tickets &amp; Trust → Terms</Link>. Changing terms never alters an order already placed.</p>
        {field('hold_minutes', 'Checkout hold (minutes)')}{field('max_tickets_per_order', 'Max tickets per order')}
        {field('buyer_refund_hours', 'Self-service refunds until (hours before the event)')}
        {field('settlement_hold_days', 'Settlement hold (days after the event ends)', 'Protects against chargebacks before organizers are paid')}
        {field('payout_min_cents', 'Minimum payout (cents)')}
        {field('payout_dual_control_cents', 'Second admin required for payouts from (cents)', `${money(Number(v('payout_dual_control_cents') || 0))}: the admin who approves cannot also confirm the transfer`)}
        {field('payout_account_cooloff_hours', 'Payout pause after bank details change (hours)', 'Stops a hijacked account from redirecting money straight away')}
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={Boolean((draft ?? {}).require_sales_review ?? c.require_sales_review ?? true)} onChange={e => set('require_sales_review', e.target.checked)} /> <span>Paid ticket sales need VYBE’s review of the event (recommended)</span></label>
      </section>
      <section className="card" aria-labelledby="vat">
        <h2 id="vat" className="t-section" style={{ marginBottom: 8 }}>VAT &amp; invoices</h2>
        <label className="row" style={{ minHeight: 44 }}><input type="checkbox" checked={Boolean((draft ?? {}).vat_registered ?? c.vat_registered)} onChange={e => set('vat_registered', e.target.checked)} /> <span>VYBE is VAT-registered (buyers get tax invoices; the service fee includes VAT)</span></label>
        {field('vat_rate_bps', 'VAT rate (basis points)', '1500 = 15 %')}
        <Field id="c-vatno" label="VAT number"><input id="c-vatno" className="input" value={v('vat_number')} onChange={e => set('vat_number', e.target.value)} /></Field>
        <Field id="c-legal" label="Legal name on invoices"><input id="c-legal" className="input" value={v('legal_name')} onChange={e => set('legal_name', e.target.value)} /></Field>
        <p className="t-meta">Have your accountant confirm the VAT treatment of the service fee and of ticket sales before turning this on.</p>
      </section>
      <div className="row"><button className="btn primary" disabled={!draft} onClick={save}>Save settings</button></div>
      <section className="card" aria-labelledby="adj">
        <h2 id="adj" className="t-section" style={{ marginBottom: 8 }}>Ledger adjustment</h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>Goodwill credits or corrections. Positive adds to what the payee is owed; negative deducts. Cannot be edited later.</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="grow"><Field id="a-org" label="Organization ID"><input id="a-org" className="input" value={adj.org} onChange={e => setAdj(a => ({ ...a, org: e.target.value.trim(), user: '' }))} /></Field></div>
          <div className="grow"><Field id="a-user" label="…or user ID"><input id="a-user" className="input" value={adj.user} onChange={e => setAdj(a => ({ ...a, user: e.target.value.trim(), org: '' }))} /></Field></div>
          <div style={{ width: 130 }}><Field id="a-amt" label="Amount (R)"><input id="a-amt" inputMode="decimal" className="input" value={adj.amount} onChange={e => setAdj(a => ({ ...a, amount: e.target.value }))} /></Field></div>
        </div>
        <Field id="a-note" label="Note (required)"><input id="a-note" className="input" value={adj.note} onChange={e => setAdj(a => ({ ...a, note: e.target.value }))} /></Field>
        <button className="btn" disabled={!adj.note || !adj.amount || (!adj.org && !adj.user)} onClick={async () => { try { await rpc('admin_add_adjustment', { p_org: adj.org || null, p_user: adj.user || null, p_amount: Math.round(parseFloat(adj.amount) * 100), p_note: adj.note }); toast('Adjustment recorded'); setAdj({ org: '', user: '', amount: '', note: '' }) } catch (e) { toast(errMsg(e)) } }}>Record adjustment</button>
      </section>
    </div>
  )
}
