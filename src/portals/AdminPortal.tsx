import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { Empty, ErrorState, Spinner } from '../ui'
import { PortalShell } from './PortalShell'

/** Role flags for the signed-in user. UX only: every admin action is re-checked by RLS / RPCs. */
function useRoles() {
  return useAsync(async () => {
    const [s, a] = await Promise.all([supabase.rpc('is_staff'), supabase.rpc('is_admin')])
    if (s.error) throw s.error
    return { staff: Boolean(s.data), admin: Boolean(a.data) }
  }, [])
}

/** /admin — platform staff only (moderators and administrators). Not reachable from the user portal's navigation unless staff. */
export function AdminPortal() {
  const roles = useRoles()
  useEffect(() => { document.title = 'Admin · VYBE' }, [])
  if (roles.loading) return <Spinner />
  if (roles.error) return <ErrorState message={roles.error} onRetry={roles.reload} />
  if (!roles.data?.staff) return <main className="portal-main"><Empty title="Not available">The admin portal is for VYBE staff.</Empty></main>
  const nav = [{ to: '/admin', label: 'Moderation', end: true }, ...(roles.data.admin ? [{ to: '/admin/finance', label: 'Finance' }, { to: '/admin/brand', label: 'Brand & Experience' }, { to: '/admin/promos', label: 'Promotions' }, { to: '/admin/discover', label: 'Discover' }, { to: '/admin/music', label: 'Music' }, { to: '/admin/verification', label: 'Verified' }] : [])]
  return <PortalShell kind="admin" label="Admin" nav={nav} />
}

/** Administrator-only pages inside the portal. */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  const roles = useRoles()
  if (roles.loading) return <Spinner />
  if (!roles.data?.admin) return <Navigate to="/admin" replace />
  return <>{children}</>
}
