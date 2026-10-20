import { useEffect } from 'react'
import { FinancePanel } from '../components/FinancePanel'

/** Your personal earnings from plans you host as yourself (organization plans are under the Organization portal). */
export default function Earnings() {
  useEffect(() => { document.title = 'Earnings · VYBE' }, [])
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Earnings</h1>
      <p className="t-support" style={{ marginBottom: 16 }}>Ticket sales for plans you host yourself.</p>
      <FinancePanel orgId={null} />
    </>
  )
}
