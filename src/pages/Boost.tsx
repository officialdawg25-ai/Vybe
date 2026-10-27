import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BarChart3, Megaphone, Pause, Play, Square } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { STATUS_TEXT, ctr, effectiveStatus, type Sponsorship, type Totals } from '../lib/sponsor'
import { money } from '../lib/tickets'
import { Empty, ErrorState, Spinner, errMsg, toast } from '../ui'

interface Row extends Sponsorship { posts: { body: string; media_type: string | null } | null }
const dateOf = (iso: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso))

/** Ads & boosts: your boosted posts with their status, real insights, and the controls (pause, resume, stop). */
export default function Boost() {
  const { uid } = useAuth()
  const [params, setParams] = useSearchParams()
  const orderId = params.get('order'), cancelled = params.get('cancelled') === '1', failed = params.get('failed') === '1'
  useEffect(() => { document.title = 'Ads & boosts · VYBE' }, [])
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('sponsored_posts').select('id,post_id,package_id,days,total_cents,goal,cta_label,cta_url,audience_city,audience_interests,status,review_note,starts_at,ends_at,paid_at,refund_due_cents,refunded_at,created_at,posts(body,media_type)').eq('sponsor', uid!).order('created_at', { ascending: false }).limit(50)
    if (error) throw error
    const rows = (data ?? []) as unknown as Row[]
    const stats = rows.length ? await supabase.from('sponsor_stats').select('sponsored_id,impressions,clicks,reach').in('sponsored_id', rows.map(r => r.id)) : { data: [] }
    const totals = new Map<string, Totals>()
    for (const s of (stats.data ?? []) as { sponsored_id: string; impressions: number; clicks: number; reach: number }[]) {
      const t = totals.get(s.sponsored_id) ?? { impressions: 0, clicks: 0, reach: 0 }
      t.impressions += s.impressions; t.clicks += s.clicks; t.reach += s.reach; totals.set(s.sponsored_id, t)
    }
    return { rows, totals }
  }, [uid])
  const mine = useAsync(async () => {
    const { data } = await supabase.from('posts').select('id,body,media_type,created_at').eq('author', uid!).eq('visibility', 'public').is('community_id', null).order('created_at', { ascending: false }).limit(8)
    return (data ?? []) as { id: string; body: string; media_type: string | null; created_at: string }[]
  }, [uid])

  // Back from the payment page: wait (briefly) for the provider's confirmation.
  const returning = Boolean(orderId) && !cancelled && !failed
  const [confirming, setConfirming] = useState(returning)
  useEffect(() => {
    if (!returning) return
    let n = 0, live = true
    const t = setInterval(async () => {
      n++
      const { data } = await supabase.from('sponsor_orders').select('status').eq('id', orderId!).maybeSingle()
      if (!live) return
      if (data?.status === 'paid') { clearInterval(t); setConfirming(false); list.reload(); setParams({}, { replace: true }) }
      else if (n >= 15) { clearInterval(t); setConfirming(false) }
    }, 2500)
    return () => { live = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, returning])

  const act = async (fn: 'pause_sponsorship' | 'stop_sponsorship', id: string, args: Record<string, unknown> = {}) => {
    if (fn === 'stop_sponsorship' && !confirm('Stop this boost? Days already delivered aren’t refunded.')) return
    const { error } = await supabase.rpc(fn, { p_id: id, ...args })
    if (error) return toast(errMsg(error)); list.reload()
  }
  const open = new Set((list.data?.rows ?? []).filter(r => ['awaiting_payment', 'in_review', 'live', 'paused'].includes(r.status)).map(r => r.post_id))

  return (
    <>
      <header className="row" style={{ alignItems: 'center', marginBottom: 12 }}><Link className="icon-btn" to="/app/profile/settings" aria-label="Back"><ArrowLeft size={22} /></Link><h1 className="t-title">Ads &amp; boosts</h1></header>
      {confirming && <p className="notice" role="status">Confirming your payment with the provider… this usually takes a few seconds.</p>}
      {cancelled && <p className="notice" role="status">Payment cancelled. You haven’t been charged.</p>}
      {failed && <p className="notice err" role="alert">The payment didn’t go through. You haven’t been charged. Please try again.</p>}
      {returning && !confirming && <p className="notice" role="status">We haven’t received the confirmation yet. If you paid, your boost moves to review as soon as your bank confirms; it’s safe to leave this page.</p>}

      <section aria-labelledby="bo-new" className="bp-sec">
        <h2 id="bo-new" className="t-section">Boost a post</h2>
        <p className="t-meta">Show one of your public posts to more people, clearly labelled “Sponsored”. Open the ⋯ menu on any of your public posts and choose <b>Boost post</b>, or pick one:</p>
        {mine.loading ? <Spinner /> : !mine.data?.length ? <p className="t-support" style={{ marginTop: 8 }}>You have no public posts yet. <Link to="/app/create" style={{ textDecoration: 'underline' }}>Create one</Link>.</p> : (
          <ul className="list">{mine.data.map(p => (
            <li key={p.id} className="item row">
              <span className="grow clamp-2">{p.body.trim() || (p.media_type === 'video' ? 'Video post' : 'Photo post')}<span className="t-meta" style={{ display: 'block' }}>{dateOf(p.created_at)}</span></span>
              {open.has(p.id) ? <span className="t-meta">Already boosted</span> : <Link className="btn sm primary" to={`/app/boost/${p.id}`}><Megaphone size={16} aria-hidden /> Boost</Link>}
            </li>))}</ul>)}
      </section>

      <section aria-labelledby="bo-list" className="bp-sec">
        <h2 id="bo-list" className="t-section">Your boosts</h2>
        {list.loading ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.rows.length ? <Empty title="No boosts yet">When you boost a post it appears here with its results.</Empty> : (
          <ul className="bo-list">{list.data.rows.map(r => {
            const st = effectiveStatus(r), t = list.data!.totals.get(r.id) ?? { impressions: 0, clicks: 0, reach: 0 }
            return (
              <li key={r.id} className="bo-card">
                <div className="row between"><b className="clamp-1">{r.posts?.body?.trim() || (r.posts?.media_type === 'video' ? 'Video post' : 'Photo post')}</b><span className={`bo-chip bo-${st}`}>{STATUS_TEXT[st]}</span></div>
                <p className="t-meta">{r.days} days · {money(r.total_cents)}{r.starts_at && r.ends_at ? ` · ${dateOf(r.starts_at)} – ${dateOf(r.ends_at)}` : ''}{r.audience_city ? ` · ${r.audience_city}` : ' · Everyone'}</p>
                {(st === 'live' || st === 'paused' || st === 'ended') && (
                  <dl className="bo-stats" aria-label="Insights">
                    <div><dt>People reached</dt><dd>{t.reach.toLocaleString()}</dd></div>
                    <div><dt>Views</dt><dd>{t.impressions.toLocaleString()}</dd></div>
                    <div><dt>Taps</dt><dd>{t.clicks.toLocaleString()}{t.impressions ? <small> · {ctr(t)}%</small> : null}</dd></div>
                  </dl>)}
                {st === 'in_review' && <p className="t-support">VYBE is reviewing this boost. It usually takes up to a business day. If it isn’t approved, you’re refunded in full.</p>}
                {st === 'rejected' && <p className="notice err" role="status">Not approved{r.review_note ? `: ${r.review_note}` : '.'} {r.refunded_at ? `You were refunded ${money(r.refund_due_cents)}.` : r.refund_due_cents > 0 ? `${money(r.refund_due_cents)} will be refunded to your original payment method.` : ''}</p>}
                {st === 'cancelled' && r.refund_due_cents > 0 && <p className="t-support">{r.refunded_at ? `Refunded ${money(r.refund_due_cents)}.` : `${money(r.refund_due_cents)} will be refunded to your original payment method.`}</p>}
                <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <Link className="btn sm" to={`/app/posts/${r.post_id}`}><BarChart3 size={16} aria-hidden /> View post</Link>
                  {st === 'live' && <button className="btn sm" onClick={() => act('pause_sponsorship', r.id, { p_pause: true })}><Pause size={16} aria-hidden /> Pause</button>}
                  {st === 'paused' && <button className="btn sm" onClick={() => act('pause_sponsorship', r.id, { p_pause: false })}><Play size={16} aria-hidden /> Resume</button>}
                  {(st === 'live' || st === 'paused' || st === 'in_review' || st === 'awaiting_payment') && <button className="btn sm danger" onClick={() => act('stop_sponsorship', r.id)}><Square size={14} aria-hidden /> {st === 'in_review' || st === 'awaiting_payment' ? 'Cancel' : 'Stop'}</button>}
                </div>
              </li>)
          })}</ul>)}
      </section>
    </>
  )
}
