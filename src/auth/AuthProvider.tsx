import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Navigate, useLocation } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'
import type { Profile } from '../lib/types'
import { Spinner } from '../ui'

interface Ctx {
  session: Session | null
  uid: string | null
  profile: Profile | null
  loading: boolean
  refreshProfile: () => Promise<void>
}
const AuthCtx = createContext<Ctx>({ session: null, uid: null, profile: null, loading: true, refreshProfile: async () => {} })
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(configured)

  const load = async (uid: string | undefined) => {
    if (!uid) { setProfile(null); return }
    const { data } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
    setProfile(data as Profile | null)
  }

  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      await load(data.session?.user.id)
      setLoading(false)
    })
    // Many tabs (or devices) can stay signed in at once: the session lives in shared storage, so we only ever drop
    // it on an explicit SIGNED_OUT, and re-read it whenever a tab regains focus in case another tab refreshed the token.
    const resync = () => { if (document.visibilityState === 'visible') supabase.auth.getSession().then(({ data }) => { if (data.session) setSession(cur => (cur?.access_token === data.session!.access_token ? cur : data.session)) }) }
    document.addEventListener('visibilitychange', resync); window.addEventListener('focus', resync)
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!s && event !== 'SIGNED_OUT' && event !== 'INITIAL_SESSION') return
      setSession(s)
      // Defer: calling supabase inside this callback can deadlock the auth lock.
      setTimeout(() => load(s?.user.id), 0)
      if (event === 'SIGNED_OUT') setProfile(null)
    })
    return () => { sub.subscription.unsubscribe(); document.removeEventListener('visibilitychange', resync); window.removeEventListener('focus', resync) }
  }, [])

  const value: Ctx = { session, uid: session?.user.id ?? null, profile, loading, refreshProfile: () => load(session?.user.id) }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

/** Route guard. UX only — all authorization is enforced by Row Level Security. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  const loc = useLocation()
  if (loading) return <Spinner />
  if (!session) return <Navigate to="/signin" replace state={{ from: loc.pathname + loc.search }} />
  if (profile && !profile.onboarded_at && loc.pathname !== '/app/onboarding') return <Navigate to="/app/onboarding" replace />
  return <>{children}</>
}

/** Only same-origin app paths are accepted as post-login destinations. */
export const safeRedirect = (from: unknown) => (typeof from === 'string' && /^\/(app|admin|org)(\/|$)/.test(from) && !from.includes('//') ? from : '/app')
