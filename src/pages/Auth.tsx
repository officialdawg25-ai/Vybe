import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase, configured, configProblem, supabaseKey, supabaseUrl } from '../lib/supabase'
import { safeRedirect, useAuth } from '../auth/AuthProvider'
import { detachTab, slotShared } from '../lib/slot'
import { Field, errMsg } from '../ui'
import { useSubmit } from '../lib/hooks'
import { LOGIN_EVENT } from '../brand/splash'
import { Lockup } from '../brand/Logo'
import { HeroContent, HeroMedia } from '../brand/HeroMedia'
import { DEFAULT_HERO, usePublishedHero } from '../lib/hero'

type Mode = 'signin' | 'signup' | 'forgot' | 'reset'
const TITLES: Record<Mode, string> = { signin: 'Sign in', signup: 'Join VYBE', forgot: 'Reset your password', reset: 'Choose a new password' }

export default function AuthPages({ mode }: { mode: Mode }) {
  const nav = useNavigate()
  const loc = useLocation()
  const { session, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [login, setLogin] = useState('')                                   // sign in: email or username
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null)
  const [busy, submit] = useSubmit()
  const { hero } = usePublishedHero()
  const from = safeRedirect((loc.state as { from?: string } | null)?.from)

  useEffect(() => { setMsg(null); document.title = `${TITLES[mode]} · VYBE` }, [mode])
  // Signed-in users skip sign-in/up; the reset page needs the recovery session, so it stays.
  useEffect(() => { if (session && mode !== 'reset') nav(from, { replace: true }) }, [session, mode, from, nav])
  // Another open tab shares this tab's (signed-out) account slot: give this tab its own slot first, so signing in here
  // does not also sign that tab in, and signing out there does not sign this tab out.
  useEffect(() => { if (!loading && !session && (mode === 'signin' || mode === 'signup') && slotShared()) detachTab(location.pathname + location.search) }, [loading, session, mode])

  // "Continue with Google" appears only when the provider is switched on in Supabase (Authentication → Providers).
  const [google, setGoogle] = useState(false)
  useEffect(() => {
    if (!configured || (mode !== 'signin' && mode !== 'signup')) return
    fetch(`${supabaseUrl}/auth/v1/settings`, { headers: { apikey: supabaseKey } }).then(r => r.json()).then(j => setGoogle(Boolean(j?.external?.google)), () => setGoogle(false))
  }, [mode])
  // Is the username free? (Only a hint: the database decides when the account is created.)
  const [taken, setTaken] = useState<boolean | null>(null)
  useEffect(() => {
    const u = username.trim().toLowerCase()
    if (mode !== 'signup' || !/^[a-z0-9_]{3,30}$/.test(u)) { setTaken(null); return }
    const t = setTimeout(() => { void supabase.rpc('username_available', { p_username: u }).then(({ data, error }) => setTaken(error ? null : data === false)) }, 350)
    return () => clearTimeout(t)
  }, [username, mode])
  const withGoogle = () => submit(async () => {
    setMsg(null)
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/signin` } })
    if (error) setMsg({ kind: 'err', text: /not enabled|unsupported/i.test(error.message) ? 'Google sign-in isn’t switched on yet. Use your email or username for now.' : errMsg(error) })
  })

  // Callback URL is derived from the live origin, never hardcoded to localhost.
  const callback = `${window.location.origin}/signin`

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!configured) return setMsg({ kind: 'err', text: configProblem() })
    submit(async () => {
      setMsg(null)
      try {
        if (mode === 'signin') {
          const id = login.trim()
          if (!id || !password) throw new Error('Enter your email or username, and your password.')
          if (id.includes('@')) {
            const { error } = await supabase.auth.signInWithPassword({ email: id, password })
            if (error) throw error
          } else {
            // Username: the username-signin function checks it server-side and hands back a session (never the email).
            const { data, error } = await supabase.functions.invoke('username-signin', { body: { username: id, password } })
            const body = (data ?? {}) as { access_token?: string; refresh_token?: string; error?: string }
            if (error || !body.access_token || !body.refresh_token) {
              const ctx = (error as { context?: Response } | null)?.context
              const detail = ctx ? ((await ctx.json().catch(() => ({}))) as { error?: string }).error : body.error
              throw new Error(detail || 'That username and password don’t match an account.')
            }
            const s2 = await supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token })
            if (s2.error) throw s2.error
          }
          window.dispatchEvent(new Event(LOGIN_EVENT))
          nav(from, { replace: true })
        } else if (mode === 'signup') {
          const uname = username.trim().toLowerCase()
          if (!/^[a-z0-9_]{3,30}$/.test(uname)) throw new Error('Username must be 3–30 characters: letters, numbers or underscores.')
          if (taken) throw new Error('That username is taken. Try another.')
          if (password.length < 8) throw new Error('Password must be at least 8 characters.')
          const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callback, data: { username: uname, display_name: uname } } })
          if (error) throw error
          if (!data.session) setMsg({ kind: 'ok', text: `Check ${email} for a confirmation link. After confirming, sign in with @${uname} or your email and we’ll set up your profile.` })
        } else if (mode === 'forgot') {
          const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset` })
          if (error) throw error
          // Same message whether or not the account exists.
          setMsg({ kind: 'ok', text: 'If an account exists for that email, a reset link is on its way.' })
        } else {
          if (password.length < 8) throw new Error('Password must be at least 8 characters.')
          const { error } = await supabase.auth.updateUser({ password })
          if (error) throw error
          nav('/app', { replace: true })
        }
      } catch (err) {
        setMsg({ kind: 'err', text: errMsg(err) })
      }
    })
  }

  return (
    <div className="auth">
      <aside className="auth-hero" aria-label="About VYBE">
        <HeroMedia hero={hero}>
          <HeroContent headline={hero ? hero.headline : DEFAULT_HERO.headline} body={hero ? hero.body : DEFAULT_HERO.body}
            logoHref={<Link to="/" aria-label="VYBE home"><Lockup height={26} tone="light" /></Link>} />
        </HeroMedia>
      </aside>
      <main className="auth-pane">
    <div className="authbox">
      <h1 className="t-title" style={{ margin: '0 0 20px' }}>{TITLES[mode]}</h1>
      {google && (mode === 'signin' || mode === 'signup') && (
        <>
          <button type="button" className="btn google-btn" disabled={busy} onClick={withGoogle}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            Continue with Google
          </button>
          <p className="or-line" aria-hidden="true"><span>or</span></p>
        </>
      )}
      <form onSubmit={onSubmit} noValidate>
        {mode === 'signup' && (
          <Field id="username" label="Username" hint={taken === true ? 'That username is taken.' : taken === false ? `@${username.trim().toLowerCase()} is available.` : 'Lowercase letters, numbers and underscores. You can sign in with it.'}>
            <input id="username" className="input" value={username} onChange={e => setUsername(e.target.value.replace(/\s/g, ''))} autoComplete="username" autoCapitalize="none" spellCheck={false} required aria-invalid={taken === true} />
          </Field>
        )}
        {mode === 'signin' && (
          <Field id="login" label="Email or username">
            <input id="login" className="input" value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
          </Field>
        )}
        {mode !== 'reset' && mode !== 'signin' && (
          <Field id="email" label="Email">
            <input id="email" type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
          </Field>
        )}
        {mode !== 'forgot' && (
          <Field id="password" label={mode === 'reset' ? 'New password' : 'Password'}>
            <input id="password" type="password" className="input" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required />
          </Field>
        )}
        {msg && <p className={`notice ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginBottom: 16 }}>{msg.text}</p>}
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Please wait…' : { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset link', reset: 'Update password' }[mode]}
        </button>
      </form>
      <p className="t-meta" style={{ marginTop: 20, display: 'grid', gap: 8 }}>
        {mode === 'signin' && <><Link to="/forgot">Forgot your password?</Link><span>New here? <Link to="/signup"><b>Join VYBE</b></Link></span></>}
        {mode === 'signup' && <span>Already a member? <Link to="/signin"><b>Sign in</b></Link></span>}
        {(mode === 'forgot' || mode === 'reset') && <Link to="/signin">Back to sign in</Link>}
      </p>
    </div>
      </main>
    </div>
  )
}
