import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { money } from '../lib/finance'
import { Empty, ErrorState, Spinner } from '../ui'
import { Wordmark } from '../brand/Logo'

interface Invoice { number: string; kind: 'receipt' | 'tax_invoice'; issued_at: string; legal_name: string; vat_number: string | null; buyer_name: string; lines: { name: string; qty: number; unit_price_cents: number; line_total_cents: number; tickets: number }[]; subtotal_cents: number; fee_cents: number; fee_vat_cents: number; total_cents: number; orders: { id: string; provider: string | null; provider_ref: string | null; refunded_cents: number; events: { title: string; starts_at: string; venue: string | null; city: string | null } | null } | null }

/** Printable receipt (or tax invoice when VYBE is VAT-registered). "Print" → Save as PDF in any browser. */
export default function Receipt() {
  const { id } = useParams()
  useEffect(() => { document.title = 'Receipt · VYBE' }, [])
  const inv = useAsync(async () => {
    const { data, error } = await supabase.from('invoices').select('number,kind,issued_at,legal_name,vat_number,buyer_name,lines,subtotal_cents,fee_cents,fee_vat_cents,total_cents,orders(id,provider,provider_ref,refunded_cents,events(title,starts_at,venue,city))').eq('order_id', id!).maybeSingle()
    if (error) throw error
    return data as unknown as Invoice | null
  }, [id])
  if (inv.loading) return <Spinner />
  if (inv.error) return <ErrorState message={inv.error} onRetry={inv.reload} />
  const i = inv.data
  if (!i) return <Empty title="No receipt yet">Receipts are issued once an order is paid.</Empty>
  const tax = i.kind === 'tax_invoice'
  const date = new Intl.DateTimeFormat('en-ZA', { dateStyle: 'long', timeZone: 'Africa/Johannesburg' }).format(new Date(i.issued_at))
  return (
    <div>
      <div className="row no-print" style={{ justifyContent: 'center', marginBottom: 12 }}><button className="btn primary" onClick={() => window.print()}>Print / Save as PDF</button><Link className="btn" to={`/app/orders/${id}`}>Back to order</Link></div>
      <article className="invoice" aria-label={tax ? 'Tax invoice' : 'Receipt'}>
        <div className="row between"><Wordmark height={20} tone="dark" /><div style={{ textAlign: 'right' }}><h1 className="t-title">{tax ? 'Tax invoice' : 'Receipt'}</h1><div className="t-meta">{i.number}</div></div></div>
        <p style={{ marginTop: 12 }}><b>{i.legal_name}</b>{tax && i.vat_number ? <> · VAT no. {i.vat_number}</> : null}<br /><span className="t-meta">Issued {date}</span></p>
        <p style={{ marginTop: 8 }}>Billed to <b>{i.buyer_name || 'VYBE member'}</b></p>
        {i.orders?.events && <p className="t-support">{i.orders.events.title}{i.orders.events.venue ? ` · ${i.orders.events.venue}` : ''}{i.orders.events.city ? `, ${i.orders.events.city}` : ''}</p>}
        <table className="fin-table" style={{ marginTop: 16 }}>
          <thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Unit</th><th scope="col">Amount</th></tr></thead>
          <tbody>
            {i.lines.map((l, k) => <tr key={k}><th scope="row">{l.name}{l.tickets > l.qty ? ` (${l.tickets} tickets)` : ''}</th><td>{l.qty}</td><td>{money(l.unit_price_cents)}</td><td>{money(l.line_total_cents)}</td></tr>)}
            <tr><th scope="row">VYBE service fee{tax && i.fee_vat_cents > 0 ? ' (incl. VAT)' : ''}</th><td>1</td><td>{money(i.fee_cents)}</td><td>{money(i.fee_cents)}</td></tr>
          </tbody>
          <tfoot>
            {tax && i.fee_vat_cents > 0 && <tr><th scope="row" colSpan={3}>of which VAT on the service fee</th><td>{money(i.fee_vat_cents)}</td></tr>}
            <tr><th scope="row" colSpan={3}>Total paid</th><td><b>{money(i.total_cents)}</b></td></tr>
            {Number(i.orders?.refunded_cents) > 0 && <tr><th scope="row" colSpan={3}>Refunded</th><td>−{money(Number(i.orders?.refunded_cents))}</td></tr>}
          </tfoot>
        </table>
        <p className="t-meta" style={{ marginTop: 12 }}>Paid via {i.orders?.provider === 'ozow' ? 'Ozow' : i.orders?.provider === 'payfast' ? 'PayFast' : 'VYBE (free tickets)'}{i.orders?.provider_ref ? ` · ref ${i.orders.provider_ref}` : ''}.
          Ticket prices are collected on behalf of the event organizer, who is responsible for any VAT on them.{!tax && ' This is a receipt, not a tax invoice.'}</p>
      </article>
    </div>
  )
}
