import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { ArrowRight, CalendarDays, Compass, Menu, MessageCircle, Radio, Users, UsersRound, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { t } from '../lib/i18n'
import { Wordmark } from '../brand/Logo'
import { HeroMedia } from '../brand/HeroMedia'
import { usePublishedHero } from '../lib/hero'

const NAV = [
  { href: '#discover', label: 'Discover' },
  { href: '#people', label: 'Your people' },
  { href: '#plans', label: 'Plans' },
  { href: '#communities', label: 'Communities' },
]

/** Only features that exist today are listed as available; anything else is labelled. */
const CAPABILITIES = [
  { id: 'discover', icon: Compass, title: 'Discover what moves you', text: 'Public plans, communities and posts from beyond your circle, filtered by the interests you pick. Every item says why you’re seeing it.' },
  { id: 'people', icon: Users, title: 'Find your people, share the moment', text: 'Add friends, post photos and videos, react and comment. You decide who sees each post: everyone, friends only, or a community.' },
  { id: 'plans', icon: CalendarDays, title: 'Make it happen', text: 'Create a plan, invite friends and track RSVPs in the right time zone. Prices and ticket links are informational — VYBE doesn’t process payments.' },
  { id: 'communities', icon: UsersRound, title: 'Build communities', text: 'Public or private communities with roles, rules and their own posts and plans.' },
  { id: 'messages', icon: MessageCircle, title: 'Keep the conversation going', text: 'Direct and group messages that carry on before and after the plan.' },
]

function PublicHeader() {
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); toggle.current?.focus() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <header className="pub-hdr">
      <div className="pub-hdr-in">
        <Link to="/" aria-label="VYBE home" className="pub-logo"><Wordmark height={22} tone="light" /></Link>
        <nav className="pub-links" aria-label="Sections">{NAV.map(n => <a key={n.href} href={n.href}>{n.label}</a>)}</nav>
        <div className="pub-actions">
          <Link className="btn ghost on-dark" to="/signin">Sign in</Link>
          <Link className="btn primary" to="/signup">Join VYBE</Link>
        </div>
        <button ref={toggle} className="icon-btn pub-menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="pub-menu" onClick={() => setOpen(o => !o)}>
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>
      {open && (
        <nav id="pub-menu" className="pub-menu" aria-label="Menu" onClick={e => { if ((e.target as HTMLElement).closest('a')) setOpen(false) }}>
          {NAV.map(n => <a key={n.href} href={n.href}>{n.label}</a>)}
          <Link to="/signin">Sign in</Link>
          <Link className="btn primary" to="/signup">Join VYBE</Link>
        </nav>
      )}
    </header>
  )
}

export default function Landing() {
  const { session } = useAuth()
  const { hero } = usePublishedHero()
  useEffect(() => { document.title = 'VYBE — Life is better together' }, [])
  if (session) return <Navigate to="/app" replace />
  return (
    <div className="landing">
      <PublicHeader />
      <main id="main">
        <section className="l-hero" aria-labelledby="l-h1">
          <HeroMedia hero={hero} className="l-hero-media" />
          <div className="l-hero-copy">
            <h1 id="l-h1" className="t-display">{t('brand.tagline')}</h1>
            <p className="lead">{t('brand.promise')}</p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <Link className="btn primary lg" to="/signup">Join VYBE <ArrowRight size={18} aria-hidden /></Link>
              <a className="btn lg on-dark-outline" href="#discover">Explore VYBE</a>
            </div>
          </div>
        </section>

        <section className="l-sec" aria-labelledby="l-poss">
          <div className="l-wrap">
            <p className="eyebrow brand">The possibilities</p>
            <h2 id="l-poss" className="t-display-sm">Everything between “we should” and “see you there”.</h2>
            <ol className="l-list">
              {CAPABILITIES.map((c, i) => (
                <li key={c.id} id={c.id} className="l-item">
                  <span className="l-num" aria-hidden>{String(i + 1).padStart(2, '0')}</span>
                  <c.icon size={26} aria-hidden className="l-ico" />
                  <div><h3>{c.title}</h3><p className="t-support">{c.text}</p></div>
                </li>
              ))}
              <li className="l-item soon">
                <span className="l-num" aria-hidden>06</span>
                <Radio size={26} aria-hidden className="l-ico" />
                <div><h3>Live experiences <span className="tag">Coming soon</span></h3>
                  <p className="t-support">You can schedule a live stream today. Going live and watching are not available yet.</p></div>
              </li>
            </ol>
          </div>
        </section>

        <section className="l-sec alt" aria-labelledby="l-two">
          <div className="l-wrap l-two">
            <div>
              <h2 id="l-two" className="t-display-sm">Two places, two purposes.</h2>
              <p className="t-support" style={{ marginTop: 12 }}>Not another feed to get lost in.</p>
            </div>
            <div className="l-pair">
              <div><h3>Home</h3><p className="t-support">Keep up with the people and communities you’ve chosen: their posts, your plans, your conversations.</p></div>
              <div><h3>Discover</h3><p className="t-support">Find what’s new to you: public plans, communities worth joining and people who share your interests.</p></div>
            </div>
          </div>
        </section>

        <section className="l-close" aria-labelledby="l-end">
          <div className="l-wrap">
            <h2 id="l-end" className="t-display-sm">Less “one day”. More “see you there”.</h2>
            <p className="lead">{t('brand.promise')}</p>
            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link className="btn primary lg" to="/signup">Create your account</Link>
              <Link className="btn lg" to="/signin">I already have one</Link>
            </div>
          </div>
        </section>
      </main>
      <footer className="l-foot">
        <div className="l-wrap row between" style={{ flexWrap: 'wrap' }}>
          <Wordmark height={18} />
          <nav className="row" aria-label="Footer" style={{ flexWrap: 'wrap' }}>
            <Link to="/signin">Sign in</Link><Link to="/signup">Join VYBE</Link><Link to="/privacy">Privacy &amp; safety</Link>
          </nav>
          <p className="t-meta" style={{ width: '100%' }}>© {new Date().getFullYear()} VYBE</p>
        </div>
      </footer>
    </div>
  )
}
