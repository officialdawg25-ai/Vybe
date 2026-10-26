import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FinancePanel } from '../components/FinancePanel'
import { useAsync } from '../lib/hooks'
import { myPromoterEarnings } from '../lib/reputation'
import { money } from '../lib/tickets'

/** Your personal earnings from plans you host as yourself (organization plans are under the Organization portal). */
export default function Earnings() {
  useEffect(() => { document.title = 'Earnings · VYBE' }, [])
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Earnings</h1>
      <p className="t-support" style={{ marginBottom: 16 }}>Ticket sales for plans you host yourself.</p>
      <FinancePanel orgId={null} />
      <PromoterEarnings />
    </>
  )
}

/** Links organisers gave you as a promoter. Earned amounts are net of refunds and sit in the journal's promoter_payable account (no payout flow yet). */
function PromoterEarnings() {
  const e = useAsync(() => myPromoterEarnings(), [])
  if (!e.data?.length) return null
  return (
    <section aria-labelledby="pe-h" style={{ marginTop: 24 }}>
      <h2 id="pe-h" className="t-section">As a promoter</h2>
      <p className="t-meta" style={{ marginBottom: 6 }}>Your share of paid orders made through your links. Refunds take back the matching share. The money is set aside from the organiser’s balance and held for you; promoter payouts aren’t available in the app yet.</p>
      <div className="list">{e.data.map(x => (
        <div key={x.link} className="item row"><span className="grow"><Link to={`/app/plans/${x.event_id}`} className="t-name">{x.event}</Link><span className="t-meta" style={{ display: 'block' }}>Code {x.code} · {x.commission_bps / 100} % · {x.orders} orders{x.active ? '' : ' · paused'}</span></span><b>{money(x.earned_cents)}</b></div>))}</div>
    </section>
  )
}
