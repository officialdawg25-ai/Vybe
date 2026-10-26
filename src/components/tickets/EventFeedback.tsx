import { useState } from 'react'
import { BadgeCheck, MessageSquareWarning, Star } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { useAsync } from '../../lib/hooks'
import {
  COMPLAINT_LABEL, ELIGIBILITY_TEXT, escalateComplaint, loadComplaints, loadReviews, replyComplaint, respondToReview, submitComplaint, submitReview,
  type Complaint, type Review,
} from '../../lib/reputation'
import { Field, Sheet, Spinner, errMsg, toast } from '../../ui'

const Stars = ({ n, label }: { n: number; label?: string }) => (
  <span className="stars" role="img" aria-label={label ?? `${n} out of 5`}>{[1, 2, 3, 4, 5].map(i => <Star key={i} size={14} aria-hidden fill={i <= n ? 'currentColor' : 'none'} />)}</span>
)

/**
 * Reviews for an event. Only ticket holders can review, after the event and within 60 days; reviews from people whose
 * ticket was scanned at the door carry "Attended". No average is shown below three reviews. Organisers can answer each
 * review once in public; moderation is VYBE's (reports go through the normal report flow).
 */
export function ReviewsSection({ eventId, manage }: { eventId: string; manage: boolean }) {
  const { uid } = useAuth()
  const st = useAsync(() => loadReviews(eventId), [eventId])
  const [writing, setWriting] = useState(false)
  if (st.loading && !st.data) return null
  if (!st.data) return null                                  // server without migration 29, or failed quietly: reviews are not essential
  const { summary, reviews, eligibility } = st.data
  const mine = reviews.find(r => r.author === uid)
  if (!reviews.length && !eligibility.eligible && !manage) return null
  return (
    <section aria-labelledby="rev-h" style={{ marginBottom: 20 }}>
      <div className="row between"><h2 id="rev-h" className="t-section">Reviews</h2>
        {summary.count > 0 && <span className="t-meta">{summary.average != null ? <><Stars n={Math.round(summary.average)} label={`Average ${summary.average} out of 5`} /> <b>{summary.average}</b> · </> : null}{summary.count} {summary.count === 1 ? 'review' : 'reviews'}{summary.verified ? ` · ${summary.verified} attended` : ''}</span>}</div>
      {summary.count > 0 && summary.average == null && <p className="t-meta">An average appears once there are three reviews.</p>}
      {eligibility.eligible
        ? <button className="btn sm" style={{ margin: '6px 0 10px' }} onClick={() => setWriting(true)}><Star size={16} aria-hidden /> {mine ? 'Edit your review' : 'Review this event'}</button>
        : !manage && !reviews.length && ELIGIBILITY_TEXT[eligibility.reason] ? <p className="t-meta">{ELIGIBILITY_TEXT[eligibility.reason]}</p> : null}
      {!reviews.length ? (manage ? <p className="t-meta">Ticket holders can review this event after it ends.</p> : null) : (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{reviews.map(r => <ReviewItem key={r.id} r={r} manage={manage} onChanged={st.reload} />)}</ul>
      )}
      {writing && <ReviewForm eventId={eventId} mine={mine} onClose={() => { setWriting(false); st.reload() }} />}
    </section>
  )
}

function ReviewItem({ r, manage, onChanged }: { r: Review; manage: boolean; onChanged: () => void }) {
  const [answer, setAnswer] = useState<string | null>(null)
  const save = async () => { try { await respondToReview(r.id, answer ?? ''); setAnswer(null); toast('Reply posted'); onChanged() } catch (e) { toast(errMsg(e)) } }
  return (
    <li className="item">
      <div className="row between"><span><Stars n={r.rating} /> <b>{r.profiles?.display_name || r.profiles?.username}</b>{r.verified_attendee && <span className="tag" style={{ marginLeft: 6 }}><BadgeCheck size={12} aria-hidden /> Attended</span>}</span>
        <span className="t-meta">{new Date(r.created_at).toLocaleDateString()}</span></div>
      {r.status === 'hidden' && <p className="t-meta">Hidden by VYBE{r.moderation_note ? `: ${r.moderation_note}` : ''}. Only you can see it.</p>}
      {r.body && <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{r.body}</p>}
      {r.organiser_response && <p className="review-reply"><b>Organiser:</b> {r.organiser_response}</p>}
      {manage && (answer == null
        ? <button className="btn sm ghost" onClick={() => setAnswer(r.organiser_response)}>{r.organiser_response ? 'Edit reply' : 'Reply'}</button>
        : <div className="stack" style={{ gap: 6 }}><textarea className="textarea" aria-label="Your public reply" maxLength={1000} value={answer} onChange={e => setAnswer(e.target.value)} />
            <div className="row" style={{ gap: 6 }}><button className="btn sm primary" onClick={() => void save()}>Post reply</button><button className="btn sm ghost" onClick={() => setAnswer(null)}>Cancel</button></div></div>)}
    </li>
  )
}

function ReviewForm({ eventId, mine, onClose }: { eventId: string; mine?: Review; onClose: () => void }) {
  const [rating, setRating] = useState(mine?.rating ?? 0)
  const [body, setBody] = useState(mine?.body ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!rating) return setErr('Choose a rating.')
    setBusy(true); setErr('')
    try { await submitReview(eventId, rating, body.trim()); toast('Thanks for your review'); onClose() } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Sheet title={mine ? 'Edit your review' : 'Review this event'} onClose={onClose}>
      <div className="row" role="radiogroup" aria-label="Rating" style={{ gap: 4, marginBottom: 12 }}>
        {[1, 2, 3, 4, 5].map(i => <button key={i} type="button" role="radio" aria-checked={rating === i} aria-label={`${i} out of 5`} className="icon-btn star-pick" data-on={i <= rating || undefined} onClick={() => setRating(i)}><Star size={26} aria-hidden fill={i <= rating ? 'currentColor' : 'none'} /></button>)}
      </div>
      <Field id="rev-body" label="What was it like? (optional)" hint="Be fair and specific. Reviews about people rather than the event may be removed."><textarea id="rev-body" className="textarea" maxLength={2000} value={body} onChange={e => setBody(e.target.value)} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary block" disabled={busy} onClick={() => void send()}>{mine ? 'Save' : 'Post review'}</button>
    </Sheet>
  )
}

/**
 * Complaints: private between the buyer and the event's organisers; the buyer can hand it to VYBE if the reply does not
 * settle it. Buyers see only their own; managers see every complaint for the event.
 */
export function ComplaintsSection({ eventId, manage, holder }: { eventId: string; manage: boolean; holder: boolean }) {
  const { uid } = useAuth()
  const list = useAsync(() => (manage || holder ? loadComplaints(eventId) : Promise.resolve(null)), [eventId, manage, holder])
  const [writing, setWriting] = useState(false)
  if (!manage && !holder) return null
  if (list.loading && !list.data) return <Spinner />
  if (list.data === null) return null
  const items = list.data ?? []
  const mine = items.filter(c => c.author === uid)
  if (manage) return (
    <section aria-labelledby="cmp-h" style={{ marginBottom: 20 }}>
      <h2 id="cmp-h" className="t-section">Complaints</h2>
      <p className="t-meta" style={{ marginBottom: 6 }}>Private messages from ticket buyers. Reply here; unresolved complaints can be passed to VYBE.</p>
      {!items.length ? <p className="t-meta">None.</p> : <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{items.map(c => <ComplaintItem key={c.id} c={c} manage onChanged={list.reload} />)}</ul>}
    </section>
  )
  return (
    <section aria-labelledby="cmp-h" style={{ marginBottom: 20 }}>
      <div className="row between"><h2 id="cmp-h" className="t-section">Problem with this event?</h2><button className="btn sm" onClick={() => setWriting(true)}><MessageSquareWarning size={16} aria-hidden /> Tell the organiser</button></div>
      {mine.length > 0 && <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{mine.map(c => <ComplaintItem key={c.id} c={c} manage={false} onChanged={list.reload} />)}</ul>}
      {writing && <ComplaintForm eventId={eventId} onClose={() => { setWriting(false); list.reload() }} />}
    </section>
  )
}

function ComplaintItem({ c, manage, onChanged }: { c: Complaint; manage: boolean; onChanged: () => void }) {
  const [reply, setReply] = useState('')
  const send = async () => { try { await replyComplaint(c.id, reply); setReply(''); toast('Reply sent'); onChanged() } catch (e) { toast(errMsg(e)) } }
  const escalate = async () => { try { await escalateComplaint(c.id); toast('Sent to VYBE'); onChanged() } catch (e) { toast(errMsg(e)) } }
  return (
    <li className="item">
      <div className="row between"><b>{c.subject}</b><span className={`tag${c.status === 'closed' ? ' muted' : ''}`}>{COMPLAINT_LABEL[c.status]}</span></div>
      <p className="t-meta">{manage ? `${c.profiles?.display_name || c.profiles?.username} · ` : ''}{new Date(c.created_at).toLocaleString()}{c.order_id ? ` · order ${c.order_id.slice(0, 8)}` : ''}</p>
      <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{c.body}</p>
      {c.organiser_reply && <p className="review-reply"><b>Organiser:</b> {c.organiser_reply}</p>}
      {c.resolution && <p className="review-reply"><b>VYBE:</b> {c.resolution}</p>}
      {manage && c.status !== 'closed' && (
        <div className="row" style={{ gap: 6, marginTop: 4 }}><input className="input grow" aria-label="Reply to this complaint" maxLength={4000} placeholder="Reply privately" value={reply} onChange={e => setReply(e.target.value)} />
          <button className="btn sm" disabled={reply.trim().length < 5} onClick={() => void send()}>Send</button></div>)}
      {!manage && (c.status === 'open' || c.status === 'answered') && <button className="btn sm ghost" onClick={() => void escalate()}>Not resolved? Ask VYBE to look</button>}
    </li>
  )
}

function ComplaintForm({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true); setErr('')
    try { await submitComplaint(eventId, subject, body); toast('Sent to the organiser'); onClose() } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Sheet title="Tell the organiser" onClose={onClose}>
      <p className="t-meta" style={{ marginBottom: 10 }}>Only the organisers (and VYBE, if you escalate) see this. For a refund, use the refund option on your ticket.</p>
      <Field id="cmp-subj" label="Subject"><input id="cmp-subj" className="input" maxLength={120} value={subject} onChange={e => setSubject(e.target.value)} /></Field>
      <Field id="cmp-body" label="What happened?"><textarea id="cmp-body" className="textarea" maxLength={4000} value={body} onChange={e => setBody(e.target.value)} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary block" disabled={busy || subject.trim().length < 3 || body.trim().length < 10} onClick={() => void send()}>Send</button>
    </Sheet>
  )
}
