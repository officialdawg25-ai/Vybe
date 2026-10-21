import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { money } from '../../lib/tickets'
import { timeAgo } from '../../lib/format'
import { ErrorState, Field, Spinner, errMsg } from '../../ui'

interface PlanRow { id: string; label: string; days: number; price_cents: number; active: boolean; sort: number }
interface OrderRow { id: string; plan_id: string; total_cents: number; provider: string; status: string; created_at: string; profiles: { username: string } | null }

/** Admin → Verified: set prices, see payments, grant or remove a badge (e.g. for impersonation). Every change is written to the audit log by the database. */
export default function AdminVerification() {
  const plans = useAsync(async () => {
    const { data, error } = await supabase.from('verification_plans').select('id,label,days,price_cents,active,sort').order('sort')
    if (error) throw error
    return (data ?? []) as PlanRow[]
  }, [])
  const orders = useAsync(async () => {
    const { data, error } = await supabase.from('badge_orders').select('id,plan_id,total_cents,provider,status,created_at,profiles:buyer(username)').order('created_at', { ascending: false }).limit(30)
    if (error) throw error
    return (data ?? []) as unknown as OrderRow[]
  }, [])
  const [price, setPrice] = useState<Record<string, string>>({})
  const [handle, setHandle] = useState(''), [days, setDays] = useState('30')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const say = (kind: 'ok' | 'err', text: string) => setMsg({ kind, text })

  const savePlan = async (p: PlanRow, patch: Partial<PlanRow>) => {
    const { error } = await supabase.from('verification_plans').update(patch).eq('id', p.id)
    if (error) return say('err', errMsg(error)); say('ok', 'Saved.'); plans.reload()
  }
  const setPrice_ = async (p: PlanRow) => {
    const rands = parseFloat(price[p.id] ?? ''); if (!Number.isFinite(rands) || rands < 1) return say('err', 'Enter a price of at least R1.')
    await savePlan(p, { price_cents: Math.round(rands * 100) }); setPrice(x => ({ ...x, [p.id]: '' }))
  }
  const grant = async (remove: boolean) => {
    const u = handle.trim().replace(/^@/, '').toLowerCase(); if (!u) return say('err', 'Enter a username.')
    const { data } = await supabase.from('profiles').select('id').eq('username', u).maybeSingle()
    if (!data) return say('err', 'No member with that username.')
    const d = parseInt(days, 10); if (!remove && (!d || d < 1 || d > 3650)) return say('err', 'Days must be between 1 and 3650.')
    const { error } = await supabase.rpc('admin_set_verified', { p_user: data.id, p_until: remove ? null : new Date(Date.now() + d * 864e5).toISOString() })
    if (error) return say('err', errMsg(error)); say('ok', remove ? 'Badge removed.' : `Badge granted for ${d} days.`); setHandle('')
  }
  if (plans.loading && !plans.data) return <Spinner />
  if (plans.error) return <ErrorState message={plans.error} onRetry={plans.reload} />
  return (
    <div className="stack">
      <div className="notice"><b>VYBE Verified</b> is a paid, time-limited badge: it confirms a subscription, not identity. Prices below start as placeholders; set the real ones. Check VAT and consumer-law wording with your accountant before launch.</div>
      <section className="card"><h2 className="t-section">Plans</h2>
        <div className="list">{(plans.data ?? []).map(p => (
          <div key={p.id} className="item row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="grow"><div className="t-name">{p.label}</div><div className="t-meta">{p.days} days · {money(p.price_cents)} · {p.active ? 'on sale' : 'hidden'}</div></div>
            <input className="input" style={{ width: 110 }} inputMode="decimal" aria-label={`New price for ${p.label} in rands`} placeholder="R" value={price[p.id] ?? ''} onChange={e => setPrice(x => ({ ...x, [p.id]: e.target.value }))} />
            <button className="btn sm" onClick={() => setPrice_(p)}>Set price</button>
            <button className="btn sm" onClick={() => savePlan(p, { active: !p.active })}>{p.active ? 'Hide' : 'Show'}</button>
          </div>))}</div>
      </section>
      <section className="card"><h2 className="t-section">Grant or remove a badge</h2>
        <Field id="vf-user" label="Username"><input id="vf-user" className="input" value={handle} onChange={e => setHandle(e.target.value)} placeholder="@username" /></Field>
        <Field id="vf-days" label="Days to grant"><input id="vf-days" className="input" inputMode="numeric" value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} /></Field>
        <div className="row"><button className="btn primary" onClick={() => grant(false)}>Grant</button><button className="btn danger" onClick={() => grant(true)}>Remove badge</button></div>
        {msg && <p className={msg.kind === 'err' ? 'error' : 't-meta'} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginTop: 8 }}>{msg.text}</p>}
      </section>
      <section className="card"><h2 className="t-section" style={{ marginBottom: 8 }}>Recent payments</h2>
        {orders.loading ? <Spinner /> : !orders.data?.length ? <p className="t-support">No payments yet.</p> : <ul className="arc">{orders.data.map(o => <li key={o.id} className="arc-row"><span className="grow"><span className="t-name">@{o.profiles?.username ?? 'unknown'}</span><span className="t-meta" style={{ display: 'block' }}>{o.plan_id} · {o.provider} · {o.status} · {timeAgo(o.created_at)}</span></span><b>{money(o.total_cents)}</b></li>)}</ul>}
      </section>
    </div>
  )
}
