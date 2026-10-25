import { useState } from 'react'
import { Copy, Download, Megaphone } from 'lucide-react'
import { useAsync } from '../../lib/hooks'
import { download, toCsv } from '../../lib/finance'
import { money } from '../../lib/tickets'
import { createPromoterLink, declareMaterialChange, doorCsvRows, doorList, loadPromoterLinks, promoterUrl, salesCsvRows, salesExport, setPromoterLinkActive } from '../../lib/reputation'
import { Field, Sheet, errMsg, toast } from '../../ui'

/**
 * Event-manager tools from migration 28: promoter links (a share of the organiser's net per referred sale, paid from the
 * organiser's balance), CSV exports without buyer contact details, and telling ticket holders about a material change
 * (which lets them get a full refund, booking fee included).
 */
export function OrganiserTools({ eventId, title }: { eventId: string; title: string }) {
  const links = useAsync(() => loadPromoterLinks(eventId), [eventId])
  const [who, setWho] = useState('')
  const [pct, setPct] = useState('10')
  const [busy, setBusy] = useState(false)
  const [changing, setChanging] = useState(false)
  if (links.data === null) return null                       // server without migration 28
  const bps = Math.round(Number(pct) * 100)
  const bad = !who.trim() || !Number.isFinite(bps) || bps < 0 || bps > 3000

  const add = async () => {
    if (busy || bad) return
    setBusy(true)
    try { const l = await createPromoterLink(eventId, who, bps); setWho(''); links.reload(); copy(promoterUrl(eventId, l.code)) } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }
  const copy = (url: string) => { void navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast(url)) }
  const toggle = async (id: string, active: boolean) => { try { await setPromoterLinkActive(id, active); links.reload() } catch (e) { toast(errMsg(e)) } }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'event'
  const exportSales = async () => { try { download(`vybe-sales-${slug}.csv`, toCsv(salesCsvRows(await salesExport(eventId)))) } catch (e) { toast(errMsg(e)) } }
  const exportDoor = async () => { try { download(`vybe-door-${slug}.csv`, toCsv(doorCsvRows(await doorList(eventId)))) } catch (e) { toast(errMsg(e)) } }

  return (
    <section className="card" aria-labelledby="ot-h" style={{ marginBottom: 20 }}>
      <h2 id="ot-h" className="t-section">Promoters &amp; exports</h2>
      <h3 className="t-name" style={{ margin: '8px 0 4px' }}>Promoter links</h3>
      <p className="t-meta" style={{ marginBottom: 6 }}>A promoter earns a share of your net on each paid order made through their link. It comes out of your balance and is taken back if the order is refunded. Promoters can’t be on your own team.</p>
      {!!links.data?.links.length && <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{links.data.links.map(l => {
        const s = links.data!.byLink.get(l.id)
        return (
          <li key={l.id} className="item row" style={{ gap: 8 }}>
            <span className="grow"><b>@{l.profiles?.username}</b> · {(l.commission_bps / 100).toString()} %<span className="t-meta" style={{ display: 'block' }}>Code {l.code} · {s?.orders ?? 0} orders · {money(s?.earned ?? 0)} earned{l.active ? '' : ' · paused'}</span></span>
            <button className="icon-btn" aria-label={`Copy @${l.profiles?.username}'s link`} onClick={() => copy(promoterUrl(eventId, l.code))}><Copy size={16} /></button>
            <button className="btn sm ghost" onClick={() => void toggle(l.id, !l.active)}>{l.active ? 'Pause' : 'Resume'}</button>
          </li>)
      })}</ul>}
      <form className="row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); void add() }}>
        <div className="grow" style={{ minWidth: 160 }}><Field id="pr-user" label="Promoter username"><input id="pr-user" className="input" autoCapitalize="none" value={who} onChange={e => setWho(e.target.value)} /></Field></div>
        <div style={{ width: 110 }}><Field id="pr-pct" label="Share %"><input id="pr-pct" className="input" inputMode="decimal" value={pct} onChange={e => setPct(e.target.value)} /></Field></div>
        <button className="btn sm" style={{ marginBottom: 16 }} disabled={busy || bad}>Create link</button>
      </form>
      {bps > 3000 && <p className="error" role="alert">The most a promoter can get is 30 %.</p>}

      <h3 className="t-name" style={{ margin: '12px 0 4px' }}>Exports</h3>
      <p className="t-meta" style={{ marginBottom: 6 }}>No emails or phone numbers are included. Each export is logged.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => void exportSales()}><Download size={16} aria-hidden /> Sales (CSV)</button>
        <button className="btn sm" onClick={() => void exportDoor()}><Download size={16} aria-hidden /> Door list (CSV)</button>
      </div>

      <h3 className="t-name" style={{ margin: '12px 0 4px' }}>Big change?</h3>
      <p className="t-meta" style={{ marginBottom: 6 }}>If the date, venue or headliner changed, tell ticket holders. Anyone who bought before the change can then get their money back straight away (booking fee included when they refund the whole order and none of it was used).</p>
      <button className="btn sm" onClick={() => setChanging(true)}><Megaphone size={16} aria-hidden /> Tell ticket holders about a change</button>
      {changing && <MaterialChange eventId={eventId} onClose={() => setChanging(false)} />}
    </section>
  )
}

function MaterialChange({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const send = async () => {
    setBusy(true); setErr('')
    try { const n = await declareMaterialChange(eventId, note); toast(n ? `${n} ticket ${n === 1 ? 'holder was' : 'holders were'} told` : 'Recorded. No ticket holders yet.'); onClose() } catch (e) { setErr(errMsg(e)); setBusy(false) }
  }
  return (
    <Sheet title="Tell ticket holders" onClose={onClose}>
      <Field id="mc-note" label="What changed?" hint="Shown on the event page and in each holder’s notification. This can’t be undone."><textarea id="mc-note" className="textarea" maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary block" disabled={busy || note.trim().length < 5} onClick={() => void send()}>Send to ticket holders</button>
    </Sheet>
  )
}
