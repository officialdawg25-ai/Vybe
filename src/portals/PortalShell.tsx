import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { PortalBoundary } from '../components/PortalBoundary'
import { ArrowLeft, LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Lockup } from '../brand/Logo'
import { ThemeButton } from '../ui'
import { configured, configProblem } from '../lib/supabase'
import { signOutThisTab } from '../lib/session'

export interface PortalNav { to: string; label: string; end?: boolean }

/** Shared chrome for the Admin and Organization portals: visually distinct from the user portal, same brand. */
export function PortalShell({ kind, label, nav, extra }: { kind: 'admin' | 'org'; label: string; nav: PortalNav[]; extra?: React.ReactNode }) {
  const go = useNavigate()
  const loc = useLocation()
  const signOut = async () => { if (await signOutThisTab()) go('/', { replace: true }) }
  return (
    <div className={`portal portal-${kind}`}>
      <a href="#main" className="skip">Skip to content</a>
      <header className="portal-hdr">
        <div className="portal-hdr-in">
          <Link to={kind === 'admin' ? '/admin' : '/org'} className="portal-brand" aria-label={`VYBE ${label}`}>
            <Lockup height={14} tone="light" /><span className="portal-tag">{label}</span>
          </Link>
          <nav className="portal-nav" aria-label={`${label} sections`}>
            {nav.map(n => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `portal-link${isActive ? ' active' : ''}`}>{n.label}</NavLink>)}
          </nav>
          <div className="portal-right">
            {extra}
            <ThemeButton className="portal-link" />
            <Link to="/app" className="portal-link"><ArrowLeft size={16} aria-hidden /> VYBE</Link>
            <button className="portal-link" onClick={signOut}><LogOut size={16} aria-hidden /> Sign out</button>
          </div>
        </div>
      </header>
      <main id="main" className="portal-main" tabIndex={-1}>
        {!configured && <div className="notice err" role="alert">{configProblem()}</div>}
        <PortalBoundary key={loc.pathname} area="This page" compact><Outlet /></PortalBoundary>
      </main>
    </div>
  )
}
