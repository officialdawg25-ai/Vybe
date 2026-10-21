import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { supabase } from '../../lib/supabase'
import { callFunction } from '../../lib/functions'
import { isVerified, loadPlans, type Plan } from '../../lib/social'
import { money, newIdempotencyKey, submitCheckout, type Checkout, type Provider } from '../../lib/tickets'
import { VerifiedBadge } from '../../components/VerifiedBadge'
import { useAsync } from '../../lib/hooks'
import { ErrorState, Spinner, errMsg } from '../../ui'

interface BadgeOrder { id: string; plan_id: string; total_cents: number; provider: string; status: string; created_at: string; paid_at: string | null }
const dateOf = (iso: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))

/** VYBE Verified: a paid, time-limited blue tick. Priced and fulfilled on the server; the badge turns on only when the payment provider confirms. */
export default function VerifiedPage() {
  const { uid, profile, refreshProfile } = useAuth()
  const [params, setParams] = useSearchParams()
  const orderId = params.get('order'), cancelled = params.get('cancelled') === '1', failed = params.get('failed') === '1'
  const [plan, setPlan] = useState('monthly'), [provider, setProvider] = useState<Provider>('payfast'), [busy, setBusy] = useState(false), [err, setErr] = useState('')
  const [key, setKey] = useState(newIdempotencyKey)
  const plans = useAsync(loadPlans, [])
  const orders = useAsync(async () => {
    const { data, error } = await supabase.from('badge_orders').select('id,plan_id,total_cents,provider,status,created_at,paid_at').eq('buyer', uid!).order('created_at', { ascending: false }).limit(10)
    if (error) return [] as BadgeOrder[]
    return (data ?? []) as BadgeOrder[]
  }, [uid])
  useEffect(() => { document.title = 'VYBE Verified · VYBE' }, [])

  // Back from the payment page: wait (briefly) for the provider's confirmation to arrive.
  const returning = orderId && !cancelled && !failed
  const [confirming, setConfirming] = useState(Boolean(returning))
  useEffect(() => {
    if (!returning) return
    let n = 0, live = true
    const t = setInterval(async () => {
      n++
      const { data } = await supabase.from('badge_orders').select('status').eq('id', orderId!).maybeSingle()
      if (!live) return
      if (data?.status === 'paid') { clearInterval(t); setConfirming(false); await refreshProfile(); orders.reload(); setParams({}, { replace: true }) }
      else if (n >= 15) { clearInterval(t); setConfirming(false) }
    }, 2500)
    return () => { live = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, returning])

  const active = isVerified(profile)
  const ready = Boolean(profile?.avatar_path && profile?.display_name?.trim())
  const chosen = plans.data?.find(p => p.id === plan) ?? plans.data?.[0]
  const buy = async () => {
    if (!chosen || busy) return
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.rpc('create_badge_order', { p_plan: chosen.id, p_provider: provider, p_idem: key })
      if (error) throw error
      const o = data as { id: string; status: string }
      if (o.status !== 'pending') { setKey(newIdempotencyKey()); throw new Error(`That order is already ${o.status}. Try again.`) }
      const checkout = await callFunction<Checkout>('pay-start', { order_id: o.id })
      submitCheckout(checkout)
    } catch (e) { setErr(errMsg(e)); setKey(newIdempotencyKey()); setBusy(false) }
  }

  if (!profile) return <Spinner />
  return (
    <>
      <header className="row" style={{ alignItems: 'center', marginBottom: 12 }}><Link className="icon-btn" to="/app/profile/settings" aria-label="Back"><ArrowLeft size={22} /></Link><h1 className="t-title">VYBE Verified</h1></header>
      {confirming && <p className="notice" role="status">Confirming your payment with the provider… this usually takes a few seconds.</p>}
      {cancelled && <p className="notice" role="status">Payment cancelled. You haven’t been charged.</p>}
      {failed && <p className="notice err" role="alert">The payment didn’t go through. You haven’t been charged. Please try again.</p>}
      {returning && !confirming && !active && <p className="notice" role="status">We haven’t received the confirmation yet. If you paid, the badge appears as soon as your bank confirms; it’s safe to leave this page.</p>}

      <section className="card vf-hero">
        <BadgeCheck size={56} fill="#1d9bf0" color="#fff" aria-hidden />
        <h2 className="t-section" style={{ marginTop: 8 }}>{active ? <>You’re verified <VerifiedBadge profile={profile} size={20} /></> : 'Get the blue tick'}</h2>
        {active ? <p className="t-support">Your badge is active until <b>{dateOf(profile.verified_until!)}</b>. Renewing adds time on top of what you have left.</p>
          : <p className="t-support">A blue tick next to your name on your profile, posts, comments and memories.</p>}
      </section>

      <section className="card" aria-labelledby="vf-what" style={{ marginTop: 12 }}>
        <h2 id="vf-what" className="t-section" style={{ marginBottom: 8 }}><ShieldCheck size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> What it is, and isn’t</h2>
        <ul className="vf-list">
          <li>It’s a <b>paid subscription period</b>: when it ends, the tick goes away unless you renew. It is not automatic renewal.</li>
          <li>It does <b>not</b> confirm who you are. VYBE staff can remove the badge from accounts that impersonate others or break the rules, without refund.</li>
          <li>You need a profile photo and a name first.</li>
        </ul>
      </section>

      <section className="card" aria-labelledby="vf-buy" style={{ marginTop: 12 }}>
        <h2 id="vf-buy" className="t-section" style={{ marginBottom: 8 }}>{active ? 'Renew' : 'Choose a plan'}</h2>
        {plans.loading ? <Spinner /> : plans.error ? <ErrorState message={plans.error} onRetry={plans.reload} /> : !plans.data?.length ? <p className="t-support">Verification isn’t available right now.</p> : (
          <>
            <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="Plan">
              {plans.data.map((p: Plan) => (
                <label key={p.id} className={`cp-opt${(chosen?.id) === p.id ? ' on' : ''}`}><input type="radio" name="plan" checked={chosen?.id === p.id} onChange={() => setPlan(p.id)} style={{ accentColor: 'var(--brand)', width: 20, height: 20 }} />
                  <span className="grow"><b>{p.label}</b><span className="t-meta" style={{ display: 'block' }}>{p.days} days</span></span><b>{money(p.price_cents)}</b></label>))}
            </div>
            <div className="field" style={{ marginTop: 12 }}><span style={{ fontWeight: 600, fontSize: '.875rem' }}>Pay with</span>
              <div className="chips" role="group" aria-label="Payment method">{(['payfast', 'ozow'] as Provider[]).map(p => <button key={p} className="chip" aria-pressed={provider === p} onClick={() => setProvider(p)}>{p === 'payfast' ? 'PayFast (card, instant EFT)' : 'Ozow (instant EFT)'}</button>)}</div></div>
            {!ready && <p className="notice" role="status" style={{ margin: '8px 0' }}>Add a profile photo and your name first. <Link to="/app/profile/edit" style={{ textDecoration: 'underline' }}>Edit profile</Link></p>}
            {err && <p className="error" role="alert">{err}</p>}
            <button className="btn primary" style={{ width: '100%', marginTop: 8 }} disabled={busy || !ready || !chosen} onClick={buy}>{busy ? 'Opening payment…' : `Pay ${chosen ? money(chosen.price_cents) : ''}`}</button>
            <p className="t-meta" style={{ marginTop: 8 }}>You’ll be taken to the payment provider’s page. Your card or bank details never touch VYBE.</p>
          </>
        )}
      </section>

      {(orders.data?.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="vf-hist" style={{ marginTop: 12 }}><h2 id="vf-hist" className="t-section" style={{ marginBottom: 8 }}>Payments</h2>
          <ul className="arc">{orders.data!.map(o => <li key={o.id} className="arc-row"><span className="grow"><span className="t-name">{o.plan_id === 'yearly' ? 'VYBE Verified · 1 year' : o.plan_id === 'monthly' ? 'VYBE Verified · 1 month' : 'VYBE Verified'}</span><span className="t-meta" style={{ display: 'block' }}>{dateOf(o.paid_at ?? o.created_at)} · {o.provider === 'ozow' ? 'Ozow' : 'PayFast'} · {o.status}</span></span><b>{money(o.total_cents)}</b></li>)}</ul></section>
      )}
    </>
  )
}
