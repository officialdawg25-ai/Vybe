import { Link, NavLink, Outlet } from 'react-router-dom'
import { ArrowLeft, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Wordmark } from '../brand/Logo'
import { supabase, configured, configProblem } from '../lib/supabase'

export interface PortalNav { to: string; label: string; end?: boolean }

/** Shared chrome for the Admin and Organization portals: visually distinct from the user portal, same brand. */
export function PortalShell({ kind, label, nav, extra }: { kind: 'admin' | 'org'; label: string; nav: PortalNav[]; extra?: React.ReactNode }) {
  const go = useNavigate()
  const signOut = async () => { await supabase.auth.signOut(); go('/', { replace: true }) }
  return (
    <div className={`portal portal-${kind}`}>
      <a href="#main" className="skip">Skip to content</a>
      <header className="portal-hdr">
        <div className="portal-hdr-in">
          <Link to={kind === 'admin' ? '/admin' : '/org'} className="portal-brand" aria-label={`VYBE ${label}`}>
            <Wordmark height={20} tone="light" /><span className="portal-tag">{label}</span>
          </Link>
          <nav className="portal-nav" aria-label={`${label} sections`}>
            {nav.map(n => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `portal-link${isActive ? ' active' : ''}`}>{n.label}</NavLink>)}
          </nav>
          <div className="portal-right">
            {extra}
            <Link to="/app" className="portal-link"><ArrowLeft size={16} aria-hidden /> VYBE</Link>
            <button className="portal-link" onClick={signOut}><LogOut size={16} aria-hidden /> Sign out</button>
          </div>
        </div>
      </header>
      <main id="main" className="portal-main" tabIndex={-1}>
        {!configured && <div className="notice err" role="alert">{configProblem()}</div>}
        <Outlet />
      </main>
    </div>
  )
}
