import { useEffect } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { CalendarDays, Compass, Users, UsersRound } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { t } from '../lib/i18n'

const PILLARS = [
  { icon: Compass, title: 'Discover', text: 'Find events, places and posts that match what you care about — and see why they appear.' },
  { icon: Users, title: 'Find your people', text: 'Connect with friends and meet people who share your interests. You choose who sees what.' },
  { icon: CalendarDays, title: 'Make plans', text: 'Create a plan, invite friends, track RSVPs in the right time zone, and show up together.' },
  { icon: UsersRound, title: 'Build communities', text: 'Join public or private communities with roles, rules and their own plans and posts.' },
]

export default function Landing() {
  const { session } = useAuth()
  useEffect(() => { document.title = 'VYBE — Life is better together' }, [])
  if (session) return <Navigate to="/app" replace />
  return (
    <div className="pub">
      <header className="pub-nav">
        <span className="t-wordmark">vybe</span>
        <nav className="row" aria-label="Account">
          <Link className="btn ghost" to="/signin">Sign in</Link>
          <Link className="btn primary" to="/signup">Join VYBE</Link>
        </nav>
      </header>
      <main>
        <section className="hero">
          <h1 className="t-display">{t('brand.tagline')}</h1>
          <p className="lead">{t('brand.promise')}</p>
          <div className="row">
            <Link className="btn primary" to="/signup">Create your account</Link>
            <Link className="btn" to="/signin">I already have one</Link>
          </div>
        </section>
        <section className="pillars" aria-label="What you can do on VYBE">
          {PILLARS.map(p => (
            <div key={p.title}>
              <p.icon size={26} color="var(--brand)" aria-hidden />
              <h3>{p.title}</h3>
              <p className="t-support">{p.text}</p>
            </div>
          ))}
        </section>
      </main>
      <footer className="t-meta" style={{ padding: '24px 0 48px', borderTop: '1px solid var(--line)' }}>
        © {new Date().getFullYear()} VYBE · <Link to="/signin">Sign in</Link>
      </footer>
    </div>
  )
}
