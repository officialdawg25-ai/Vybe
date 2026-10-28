import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, FileUp, ScanLine, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { useAsync } from '../../lib/hooks'
import { supabase } from '../../lib/supabase'
import { uploadMedia } from '../../lib/media'
import { money } from '../../lib/tickets'
import { EVIDENCE_LABEL, REVIEW_LABEL, addEvidence, addStaff, loadReview, loadStaff, removeStaff, submitForReview, type EvidenceKind, type ReviewState } from '../../lib/trust'
import { Field, Spinner, errMsg, toast } from '../../ui'

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)} %`
function termsText(t: NonNullable<ReviewState['terms']>) {
  const parts: string[] = []
  if (t.commission_bps || t.commission_fixed_cents || t.commission_per_ticket_cents)
    parts.push(`VYBE keeps ${[t.commission_bps ? pct(t.commission_bps) + ' of ticket sales' : '', t.commission_fixed_cents ? money(t.commission_fixed_cents) + ' per order' : '', t.commission_per_ticket_cents ? money(t.commission_per_ticket_cents) + ' per ticket' : ''].filter(Boolean).join(' + ')}`)
  else parts.push('No commission is taken from your ticket sales')
  if (t.buyer_fee_enabled) parts.push(`buyers pay a service fee of ${[t.buyer_fee_bps ? pct(t.buyer_fee_bps) : '', t.buyer_fee_fixed_cents ? money(t.buyer_fee_fixed_cents) + ' per order' : '', t.buyer_fee_per_ticket_cents ? money(t.buyer_fee_per_ticket_cents) + ' per ticket' : ''].filter(Boolean).join(' + ')} on top`)
  else parts.push('buyers pay the ticket price only')
  return parts.join('; ')
}

/**
 * For an event's managers: where paid ticket sales stand with VYBE's review, the evidence sent, what the event is charged,
 * and who may scan tickets at the door. Free tickets never need review. Approval is VYBE's decision, made server-side.
 */
export function SalesReviewPanel({ eventId }: { eventId: string }) {
  const { uid } = useAuth()
  const paid = useAsync(async () => { const { count } = await supabase.from('ticket_types').select('id', { count: 'exact', head: true }).eq('event_id', eventId).gt('price_cents', 0); return (count ?? 0) > 0 }, [eventId])
  const hasPaidTickets = Boolean(paid.data)
  const st = useAsync(() => loadReview(eventId), [eventId])
  const staff = useAsync(() => loadStaff(eventId), [eventId])
  const modernDoor = useAsync(async () => !(await supabase.from('event_staff').select('gate_id').limit(1)).error, [])
  const [kind, setKind] = useState<EvidenceKind>('organiser_identity')
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [who, setWho] = useState('')
  const fileIn = useRef<HTMLInputElement>(null)
  if (st.loading && !st.data) return <Spinner />
  if (st.data === null) return null                                   // server without migration 28
  if (st.error || !st.data) return <p className="error" role="alert">{st.error}</p>
  const r = st.data
  const canSubmit = r.status === 'not_submitted' || r.status === 'rejected'

  const send = async () => {
    if (busy) return
    if (!note.trim() && !file) return setMsg('Describe the evidence or attach a photo of it.')
    setBusy(true); setMsg('')
    try {
      const path = file ? (await uploadMedia(uid!, file)).path : null
      await addEvidence(eventId, kind, note.trim(), path)
      setNote(''); setFile(null); if (fileIn.current) fileIn.current.value = ''
      toast('Evidence added'); st.reload()
    } catch (e) { setMsg(errMsg(e)) } finally { setBusy(false) }
  }
  const submit = async () => {
    if (busy) return
    setBusy(true); setMsg('')
    try { await submitForReview(eventId, ''); toast('Sent to VYBE for review'); st.reload() } catch (e) { setMsg(errMsg(e)) } finally { setBusy(false) }
  }
  const add = async () => { try { await addStaff(eventId, who, uid!); setWho(''); staff.reload(); toast('Added to the door team') } catch (e) { toast(errMsg(e)) } }
  const drop = async (id: string) => { try { await removeStaff(eventId, id); staff.reload() } catch (e) { toast(errMsg(e)) } }

  return (
    <section className="card trust" aria-labelledby="trust-h" style={{ marginBottom: 20 }}>
      <div className="row between"><h2 id="trust-h" className="t-section">Ticket sales &amp; door</h2>
        <span className={`trust-chip s-${r.status}`}>{r.status === 'approved' ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />} {REVIEW_LABEL[r.status]}</span></div>
      <p className="t-support" style={{ margin: '6px 0 10px' }}>
        {r.status === 'approved' ? 'Paid tickets are on sale.'
          : r.status === 'suspended' ? 'Paid sales are paused by VYBE. Existing tickets stay valid unless you are told otherwise.'
          : hasPaidTickets ? 'Paid tickets go on sale once VYBE has checked who is organising and that you have the venue. Free tickets work now.'
          : 'Only paid tickets need a review. Free tickets work now.'}
      </p>
      {r.note && r.status !== 'submitted' && <p className="notice" role="status" style={{ marginBottom: 10 }}><b>VYBE:</b> {r.note}</p>}
      {r.terms && <p className="t-meta" style={{ marginBottom: 10 }}><BadgeCheck size={12} aria-hidden /> Terms: {termsText(r.terms)}. ({r.terms.name})</p>}

      <h3 className="t-name" style={{ margin: '10px 0 6px' }}>Evidence</h3>
      {!r.evidence.length ? <p className="t-meta">Nothing sent yet.</p> : (
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{r.evidence.map(e => (
          <li key={e.id} className="item row"><span className="grow"><b>{EVIDENCE_LABEL[e.kind]}</b>{e.note && <span className="t-meta" style={{ display: 'block' }}>{e.note}</span>}{e.file_path && <span className="t-meta" style={{ display: 'block' }}>Photo attached</span>}{e.review_reason && <span className="t-meta" style={{ display: 'block' }}>VYBE: {e.review_reason}</span>}</span>
            <span className={`tag${e.status === 'approved' ? '' : ' muted'}`}>{e.status}</span></li>))}</ul>
      )}
      <div className="trust-add">
          <Field id="ev-kind" label="What is this?"><select id="ev-kind" className="select" value={kind} onChange={e => setKind(e.target.value as EvidenceKind)}>{(Object.keys(EVIDENCE_LABEL) as EvidenceKind[]).map(k => <option key={k} value={k}>{EVIDENCE_LABEL[k]}</option>)}</select></Field>
          <Field id="ev-note" label="Details" hint="e.g. company registration number, the venue contact who confirmed your booking, the agent who confirmed the artist"><textarea id="ev-note" className="textarea" maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></Field>
          <input ref={fileIn} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => fileIn.current?.click()}><FileUp size={16} aria-hidden /> {file ? file.name : 'Attach a photo (optional)'}</button>
            <button className="btn sm" disabled={busy} onClick={() => void send()}>Add evidence</button>
            {canSubmit && <button className="btn sm primary" disabled={busy || !r.evidence.length} onClick={() => void submit()}>Submit for review</button>}
          </div>
          <p className="t-meta" style={{ marginTop: 6 }}>Only VYBE reviewers and this event’s managers can see evidence. Don’t upload ID documents of other people.</p>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
      {r.decisions.length > 0 && <details style={{ marginTop: 10 }}><summary className="t-meta">History</summary>
        <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{r.decisions.map(d => <li key={d.id} className="item t-meta">{new Date(d.created_at).toLocaleString()} · {d.from_status.replace('_', ' ')} → {d.to_status.replace('_', ' ')}{d.reason ? ` · ${d.reason}` : ''}</li>)}</ul></details>}

      {/* With migration 43 the door team (roles, gates, expiry) lives in "Entry, gates & seating". */}
      {modernDoor.data ? null : <>
      <h3 className="t-name" style={{ margin: '16px 0 6px' }}>Door team</h3>
      <p className="t-meta" style={{ marginBottom: 6 }}>People here can scan tickets for this event only. They never see ticket codes, orders or money.</p>
      {staff.data === null ? <p className="t-meta">Door teams need the latest database update.</p> : (
        <>
          <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{(staff.data ?? []).map(s => (
            <li key={s.user_id} className="item row"><span className="grow">{s.profiles?.display_name || s.profiles?.username} <span className="t-meta">@{s.profiles?.username}</span></span>
              <button className="icon-btn" aria-label={`Remove @${s.profiles?.username} from the door team`} onClick={() => void drop(s.user_id)}><Trash2 size={16} /></button></li>))}</ul>
          <form className="row" style={{ alignItems: 'flex-end', gap: 8 }} onSubmit={e => { e.preventDefault(); void add() }}>
            <div className="grow"><Field id="door-user" label="Add by username"><input id="door-user" className="input" autoCapitalize="none" value={who} onChange={e => setWho(e.target.value)} /></Field></div>
            <button className="btn sm" style={{ marginBottom: 16 }} disabled={!who.trim()}>Add</button>
          </form>
        </>
      )}
      </>}
      <Link className="btn sm" to={`/app/scan/${eventId}`}><ScanLine size={16} aria-hidden /> Open the door scanner</Link>
    </section>
  )
}
