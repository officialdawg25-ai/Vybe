import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { money } from '../../lib/tickets'
import { GOALS, STATUS_TEXT, type SponsorStatus } from '../../lib/sponsor'
import { timeAgo } from '../../lib/format'
import { Empty, ErrorState, Field, Spinner, errMsg, toast, useSigned } from '../../ui'

interface Queued {
  id: string; status: SponsorStatus; post_id: string; body: string; media_path: string | null; media_type: 'image' | 'video' | null
  sponsor_name: string; sponsor_username: string; goal: string; cta_url: string | null; cta_label: string | null; audience_city: string | null; audience_interests: string[]
  days: number; total_cents: number; paid_at: string | null; refund_due_cents: number; refunded_at: string | null; review_note: string | null
}
interface Pkg { id: string; label: string; days: number; price_cents: number; active: boolean; sort: number }

/** Admin → Sponsored posts: review boosts against the ad rules, record refunds, and set package prices. Every decision is written to the audit log by the database. */
export default function AdminSponsorship() {
  const queue = useAsync(async () => {
    const { data, error } = await supabase.rpc('admin_sponsorship_queue')
    if (error) throw error
    return (Array.isArray(data) ? data : []) as Queued[]
  }, [])
  const pkgs = useAsync(async () => {
    const { data, error } = await supabase.from('boost_packages').select('id,label,days,price_cents,active,sort').order('sort')
    if (error) throw error
    return (data ?? []) as Pkg[]
  }, [])
  const [price, setPrice] = useState<Record<string, string>>({})
  const review = queue.data?.filter(q => q.status === 'in_review') ?? []
  const refunds = queue.data?.filter(q => q.refund_due_cents > 0 && !q.refunded_at) ?? []

  const savePkg = async (p: Pkg, patch: Partial<Pkg>) => {
    const { error } = await supabase.from('boost_packages').update(patch).eq('id', p.id)
    if (error) return toast(errMsg(error)); toast('Saved'); pkgs.reload()
  }
  const setP = async (p: Pkg) => {
    const rands = parseFloat(price[p.id] ?? ''); if (!Number.isFinite(rands) || rands < 5) return toast('Enter a price of at least R5.')
    await savePkg(p, { price_cents: Math.round(rands * 100) }); setPrice(x => ({ ...x, [p.id]: '' }))
  }

  if (queue.loading && !queue.data) return <Spinner />
  if (queue.error) return <ErrorState message={queue.error} onRetry={queue.reload} />
  return (
    <div className="stack">
      <div className="notice"><b>Sponsored posts</b> are paid boosts of public posts. Approve only what follows the ad rules (honest, lawful, no harmful or misleading claims, the sponsor has the rights to the media, links are to a real destination). A rejection refunds the sponsor in full; record the refund below once you have made it in the payment provider’s dashboard.</div>

      <section className="card" aria-labelledby="sp-q"><h2 id="sp-q" className="t-section">Waiting for review ({review.length})</h2>
        {!review.length ? <Empty title="Nothing to review">Paid boosts appear here.</Empty> : <div className="list">{review.map(q => <ReviewRow key={q.id} q={q} onDone={queue.reload} />)}</div>}
      </section>

      <section className="card" aria-labelledby="sp-r"><h2 id="sp-r" className="t-section">Refunds to make ({refunds.length})</h2>
        {!refunds.length ? <p className="t-support" style={{ marginTop: 6 }}>No refunds outstanding.</p> : <div className="list">{refunds.map(q => <RefundRow key={q.id} q={q} onDone={queue.reload} />)}</div>}
      </section>

      <section className="card" aria-labelledby="sp-p"><h2 id="sp-p" className="t-section">Packages</h2>
        <p className="t-meta">Prices start as placeholders; set the real ones. Changing a price affects only new boosts. Check VAT and consumer-law wording with your accountant before launch.</p>
        {pkgs.loading ? <Spinner /> : pkgs.error ? <ErrorState message={pkgs.error} onRetry={pkgs.reload} /> : (
          <div className="list">{(pkgs.data ?? []).map(p => (
            <div key={p.id} className="item row" style={{ flexWrap: 'wrap' }}>
              <span className="grow"><b>{p.label}</b><span className="t-meta" style={{ display: 'block' }}>{p.days} days · now {money(p.price_cents)}</span></span>
              <input className="input" style={{ width: 110 }} inputMode="decimal" aria-label={`New price in rand for ${p.label}`} placeholder="Rand" value={price[p.id] ?? ''} onChange={e => setPrice(x => ({ ...x, [p.id]: e.target.value }))} />
              <button className="btn sm" onClick={() => setP(p)}>Set price</button>
              <button className="btn sm" aria-pressed={p.active} onClick={() => savePkg(p, { active: !p.active })}>{p.active ? 'On sale' : 'Off'}</button>
            </div>))}</div>)}
      </section>
    </div>
  )
}

function ReviewRow({ q, onDone }: { q: Queued; onDone: () => void }) {
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const media = useSigned(q.media_type === 'image' ? q.media_path : null)
  const decide = async (approve: boolean) => {
    if (busy) return
    if (!approve && note.trim().length < 3) return toast('Say why it isn’t approved (the sponsor will see this).')
    setBusy(true)
    const { error } = await supabase.rpc('admin_review_sponsorship', { p_id: q.id, p_approve: approve, p_note: note.trim() || null })
    setBusy(false)
    if (error) return toast(errMsg(error)); toast(approve ? 'Approved — it is live.' : 'Not approved — refund due.'); onDone()
  }
  return (
    <div className="item stack" style={{ gap: 8 }}>
      <div className="row between"><b>{q.sponsor_name || q.sponsor_username} <span className="t-meta">@{q.sponsor_username}</span></b><span className="t-meta">{q.paid_at ? `Paid ${timeAgo(q.paid_at)}` : ''}</span></div>
      {q.body && <p style={{ whiteSpace: 'pre-wrap' }}>{q.body}</p>}
      {media && <img src={media} alt="" style={{ maxHeight: 220, borderRadius: 12, objectFit: 'cover' }} />}
      {q.media_type === 'video' && <p className="t-meta">Contains a video — <a href={`/app/posts/${q.post_id}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>open the post</a> to watch it.</p>}
      <p className="t-meta">{GOALS.find(g => g.id === q.goal)?.title ?? q.goal} · {q.days} days · {money(q.total_cents)} · {q.audience_city ?? 'Everyone'}{q.audience_interests.length ? ` · ${q.audience_interests.join(', ')}` : ''}</p>
      {q.cta_url && <p className="t-meta">Button “{q.cta_label}” → <a href={q.cta_url} target="_blank" rel="noopener noreferrer nofollow" style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>{q.cta_url}</a> (check the destination)</p>}
      <Field id={`n-${q.id}`} label="Note to the sponsor (required to reject)"><input id={`n-${q.id}`} className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <div className="row"><button className="btn primary sm" disabled={busy} onClick={() => decide(true)}>Approve</button><button className="btn sm danger" disabled={busy} onClick={() => decide(false)}>Don’t approve (refund)</button></div>
    </div>
  )
}

function RefundRow({ q, onDone }: { q: Queued; onDone: () => void }) {
  const [ref, setRef] = useState(''), [busy, setBusy] = useState(false)
  const mark = async () => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.rpc('admin_mark_sponsor_refunded', { p_id: q.id, p_ref: ref })
    setBusy(false)
    if (error) return toast(errMsg(error)); toast('Refund recorded.'); onDone()
  }
  return (
    <div className="item row" style={{ flexWrap: 'wrap' }}>
      <span className="grow"><b>{money(q.refund_due_cents)}</b> to {q.sponsor_name || q.sponsor_username}<span className="t-meta" style={{ display: 'block' }}>{STATUS_TEXT[q.status]}{q.review_note ? ` · ${q.review_note}` : ''}</span></span>
      <input className="input" style={{ width: 200 }} aria-label="Provider refund reference" placeholder="Provider refund reference" value={ref} onChange={e => setRef(e.target.value)} />
      <button className="btn sm" disabled={busy || ref.trim().length < 2} onClick={mark}>Mark refunded</button>
    </div>
  )
}
