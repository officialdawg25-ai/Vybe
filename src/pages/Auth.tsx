import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'
import { safeRedirect, useAuth } from '../auth/AuthProvider'
import { Field, errMsg } from '../ui'
import { useSubmit } from '../lib/hooks'
import { t } from '../lib/i18n'

type Mode = 'signin' | 'signup' | 'forgot' | 'reset'
const TITLES: Record<Mode, string> = { signin: 'Welcome back', signup: 'Join VYBE', forgot: 'Reset your password', reset: 'Choose a new password' }

export default function AuthPages({ mode }: { mode: Mode }) {
  const nav = useNavigate()
  const loc = useLocation()
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null)
  const [busy, submit] = useSubmit()
  const from = safeRedirect((loc.state as { from?: string } | null)?.from)

  useEffect(() => { setMsg(null); document.title = `${TITLES[mode]} · VYBE` }, [mode])
  // Signed-in users skip sign-in/up; the reset page needs the recovery session, so it stays.
  useEffect(() => { if (session && mode !== 'reset') nav(from, { replace: true }) }, [session, mode, from, nav])

  // Callback URL is derived from the live origin, never hardcoded to localhost.
  const callback = `${window.location.origin}/signin`

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!configured) return setMsg({ kind: 'err', text: t('error.config') })
    submit(async () => {
      setMsg(null)
      try {
        if (mode === 'signin') {
          const { error } = await supabase.auth.signInWithPassword({ email, password })
          if (error) throw error
          nav(from, { replace: true })
        } else if (mode === 'signup') {
          const uname = username.trim().toLowerCase()
          if (!/^[a-z0-9_]{3,30}$/.test(uname)) throw new Error('Username must be 3–30 characters: letters, numbers or underscores.')
          if (password.length < 8) throw new Error('Password must be at least 8 characters.')
          const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callback, data: { username: uname, display_name: uname } } })
          if (error) throw error
          if (!data.session) setMsg({ kind: 'ok', text: 'Check your email to confirm your account, then sign in.' })
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
    <div className="authbox">
      <Link to="/" className="t-wordmark" aria-label="VYBE home">vybe</Link>
      <h1 className="t-title" style={{ margin: '24px 0 20px' }}>{TITLES[mode]}</h1>
      <form onSubmit={onSubmit} noValidate>
        {mode === 'signup' && (
          <Field id="username" label="Username" hint="Lowercase letters, numbers and underscores.">
            <input id="username" className="input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
          </Field>
        )}
        {mode !== 'reset' && (
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
  )
}
