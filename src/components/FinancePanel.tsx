import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { callFunction } from '../lib/functions'
import { download, money, toCsv, type Balance } from '../lib/finance'
import { isMissingSchema } from '../lib/tickets'
import { Empty, ErrorState, Field, Spinner, errMsg, toast } from '../ui'
import { formatEventTime } from '../lib/format'

interface Entry { id: number; kind: string; amount_cents: number; note: string; created_at: string; event_id: string | null; events: { title: string } | null }
interface Payout { id: string; amount_cents: number; status: string; created_at: string; paid_at: string | null; bank_reference: string | null; note: string }
interface Account { id: string; holder: string; bank: string; account_last4: string; status: string }

/** Earnings, statement, payout account and payouts for one organization (orgId) or for you personally (orgId = null). */
export function FinancePanel({ orgId }: { orgId: string | null }) {
  const { uid } = useAuth()
  const [editing, setEditing] = useState(false)
  const [busy, submit] = useSubmit()
  const bal = useAsync(async () => {
    const { data, error } = await supabase.rpc('payout_balance', { p_org: orgId })
    if (error) { if (isMissingSchema(error)) return null; throw error }
    return data as Balance
  }, [orgId])
  const entries = useAsync(async () => {
    const q = supabase.from('ledger_entries').select('id,kind,amount_cents,note,created_at,event_id,events(title)').order('id', { ascending: false }).limit(300)
    const { data, error } = await (orgId ? q.eq('organization_id', orgId) : q.eq('payee_user', uid!))
    if (error) { if (isMissingSchema(error)) return [] as Entry[]; throw error }
    return (data ?? []) as unknown as Entry[]
  }, [orgId, uid])
  const payouts = useAsync(async () => {
    const q = supabase.from('payouts').select('id,amount_cents,status,created_at,paid_at,bank_reference,note').order('created_at', { ascending: false }).limit(50)
    const { data, error } = await (orgId ? q.eq('organization_id', orgId) : q.eq('user_id', uid!))
    if (error) { if (isMissingSchema(error)) return [] as Payout[]; throw error }
    return (data ?? []) as Payout[]
  }, [orgId, uid])
  const account = useAsync(async () => {
    const q = supabase.from('payout_accounts').select('id,holder,bank,account_last4,status')
    const { data, error } = await (orgId ? q.eq('organization_id', orgId) : q.eq('user_id', uid!)).maybeSingle()
    if (error) { if (isMissingSchema(error)) return null; throw error }
    return data as Account | null
  }, [orgId, uid])

  const requestPayout = () => submit(async () => {
    const { error } = await supabase.rpc('request_payout', { p_org: orgId })
    if (error) return toast(error.message)
    toast('Payout requested. VYBE staff review it before paying.'); bal.reload(); payouts.reload()
  })

  if (bal.loading || entries.loading) return <Spinner />
  if (bal.error) return <ErrorState message={bal.error} onRetry={bal.reload} />
  if (!bal.data) return <Empty title="Finance isn’t switched on yet">Ticket earnings appear here once the latest database update has been applied.</Empty>
  const b = bal.data
  const byEvent = new Map<string, { title: string; sales: number; refunds: number }>()
  for (const e of entries.data ?? []) {
    const k = e.event_id ?? 'other'; const row = byEvent.get(k) ?? { title: e.events?.title ?? 'Adjustments and payouts', sales: 0, refunds: 0 }
    if (e.kind === 'sale') row.sales += Number(e.amount_cents); else if (e.kind === 'refund' || e.kind === 'chargeback') row.refunds += Number(e.amount_cents)
    byEvent.set(k, row)
  }
  const exportCsv = () => download(`vybe-statement-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([['Date', 'Event', 'Type', 'Amount (ZAR)', 'Note'], ...(entries.data ?? []).map(e => [new Date(e.created_at).toISOString(), e.events?.title ?? '', e.kind, (Number(e.amount_cents) / 100).toFixed(2), e.note])]))

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section aria-label="Balance" className="fin-cards">
        <div className="card"><div className="t-meta">Available to pay out</div><div className="fin-big">{money(b.available_cents)}</div><div className="t-meta">Sales settle {b.hold_days} days after an event ends</div></div>
        <div className="card"><div className="t-meta">Total sales</div><div className="fin-big">{money(b.gross_sales_cents)}</div><div className="t-meta">Refunds &amp; chargebacks −{money(b.refunds_and_chargebacks_cents)}</div></div>
        <div className="card"><div className="t-meta">Paid out</div><div className="fin-big">{money(b.paid_out_cents)}</div><div className="t-meta">{b.pending_payout_cents ? `${money(b.pending_payout_cents)} in progress` : 'Nothing pending'}</div></div>
      </section>
      {b.open_disputes_cents > 0 && <p className="notice err" role="status">{money(b.open_disputes_cents)} is held while a chargeback is investigated.</p>}

      <section aria-labelledby="fin-acc">
        <div className="row between"><h2 id="fin-acc" className="t-section">Payout account</h2><button className="btn sm" onClick={() => setEditing(true)}>{account.data ? 'Change' : 'Add bank account'}</button></div>
        {account.data ? <p className="t-support" style={{ marginTop: 4 }}>{account.data.holder} · {account.data.bank} ·••••{account.data.account_last4} · <b>{account.data.status === 'verified' ? 'Verified' : account.data.status === 'rejected' ? 'Rejected — please re-enter' : 'Waiting for verification'}</b></p> : <p className="t-support" style={{ marginTop: 4 }}>Add a South African bank account to receive payouts. Details are encrypted and only visible to VYBE finance staff.</p>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy || b.available_cents < b.min_payout_cents || account.data?.status !== 'verified'} onClick={requestPayout}>Request payout of {money(b.available_cents)}</button>
          {b.available_cents < b.min_payout_cents && <span className="t-meta">Minimum payout is {money(b.min_payout_cents)}</span>}
        </div>
        {editing && <AccountForm orgId={orgId} onDone={() => { setEditing(false); account.reload() }} />}
      </section>

      <section aria-labelledby="fin-pay">
        <h2 id="fin-pay" className="t-section">Payouts</h2>
        {!payouts.data?.length ? <p className="t-support">No payouts yet.</p> : <div className="list">{payouts.data.map(p => (
          <div key={p.id} className="item row"><div className="grow"><div className="t-name">{money(p.amount_cents)} · {p.status}</div><div className="t-meta">{formatEventTime(p.created_at, 'Africa/Johannesburg')}{p.bank_reference ? ` · ref ${p.bank_reference}` : ''}{p.note ? ` · ${p.note}` : ''}</div></div></div>))}</div>}
      </section>

      <section aria-labelledby="fin-st">
        <div className="row between"><h2 id="fin-st" className="t-section">Statement</h2><button className="btn sm" onClick={exportCsv} disabled={!entries.data?.length}>Download CSV</button></div>
        {entries.error ? <ErrorState message={entries.error} onRetry={entries.reload} /> : !byEvent.size ? <p className="t-support">Sales will appear here.</p> : (
          <table className="fin-table"><thead><tr><th scope="col">Event</th><th scope="col">Sales</th><th scope="col">Refunds</th><th scope="col">Net</th></tr></thead>
            <tbody>{[...byEvent.values()].map((r, i) => <tr key={i}><th scope="row">{r.title}</th><td>{money(r.sales)}</td><td>{money(r.refunds)}</td><td>{money(r.sales + r.refunds)}</td></tr>)}</tbody></table>
        )}
        <p className="t-meta" style={{ marginTop: 8 }}>Amounts are what you earn from ticket prices. The buyer-paid service fee belongs to VYBE and is not part of your sales. Gateway fees are not deducted here.</p>
      </section>
    </div>
  )
}

function AccountForm({ orgId, onDone }: { orgId: string | null; onDone: () => void }) {
  const [f, setF] = useState({ holder: '', bank: '', account_number: '', branch_code: '', account_type: 'cheque' })
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(s => ({ ...s, [k]: k === 'account_number' || k === 'branch_code' ? e.target.value.replace(/\D/g, '') : e.target.value }))
  const save = () => submit(async () => {
    setErr('')
    try { await callFunction('payout-account', { action: 'save', organization_id: orgId, ...f }); toast('Saved. VYBE staff will verify it.'); onDone() } catch (e) { setErr(errMsg(e)) }
  })
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <Field id="b-holder" label="Account holder"><input id="b-holder" className="input" value={f.holder} onChange={set('holder')} autoComplete="off" /></Field>
      <Field id="b-bank" label="Bank"><input id="b-bank" className="input" value={f.bank} onChange={set('bank')} autoComplete="off" /></Field>
      <div className="row"><div className="grow"><Field id="b-acc" label="Account number"><input id="b-acc" inputMode="numeric" className="input" value={f.account_number} onChange={set('account_number')} autoComplete="off" /></Field></div>
        <div className="grow"><Field id="b-br" label="Branch code"><input id="b-br" inputMode="numeric" className="input" value={f.branch_code} onChange={set('branch_code')} autoComplete="off" /></Field></div></div>
      <Field id="b-type" label="Account type"><select id="b-type" className="select" value={f.account_type} onChange={set('account_type')}><option value="cheque">Cheque / current</option><option value="savings">Savings</option><option value="transmission">Transmission</option></select></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onDone}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save securely</button></div>
    </div>
  )
}
