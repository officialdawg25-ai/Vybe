import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { Bell, CalendarDays, Compass, MessageCircle, Search, Settings, User, Users, UsersRound } from 'lucide-react'
import { useAuth } from './auth/AuthProvider'
import { configured, supabase } from './lib/supabase'
import { t } from './lib/i18n'

const NAV = [
  { to: '/app', end: true, icon: Compass, label: t('nav.discover') },
  { to: '/app/friends', icon: Users, label: t('nav.friends') },
  { to: '/app/plans', icon: CalendarDays, label: t('nav.plans') },
  { to: '/app/communities', icon: UsersRound, label: t('nav.communities') },
] as const

/** Unread notification count, kept current via Realtime (RLS limits events to the user's own rows). */
function useUnread(uid: string | null) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!uid) return
    const count = async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
      setN(count ?? 0)
    }
    count()
    const ch = supabase.channel(`notif:${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, count)
      .subscribe()
    const onFocus = () => count()
    window.addEventListener('vybe:notifications', onFocus)
    return () => { window.removeEventListener('vybe:notifications', onFocus); supabase.removeChannel(ch) }
  }, [uid])
  return n
}

export function Shell() {
  const { uid, profile } = useAuth()
  const unread = useUnread(uid)
  const mine = profile ? `/app/u/${profile.username}` : '/app/settings'
  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <Link to="/app" className="t-wordmark" style={{ padding: '0 12px 16px' }}>vybe</Link>
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <n.icon size={22} aria-hidden /> {n.label}
          </NavLink>
        ))}
        <NavLink to="/app/messages" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><MessageCircle size={22} aria-hidden /> {t('nav.messages')}</NavLink>
        <NavLink to="/app/notifications" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <Bell size={22} aria-hidden /> {t('nav.notifications')}{unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink to={mine} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><User size={22} aria-hidden /> {t('nav.profile')}</NavLink>
        <NavLink to="/app/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><Settings size={22} aria-hidden /> {t('nav.settings')}</NavLink>
      </nav>

      <div className="content">
        <header className="topbar">
          <Link to="/app" className="t-wordmark" aria-label="VYBE home">vybe</Link>
          <div className="grow" />
          <Link to="/app/search" className="icon-btn" aria-label={t('nav.search')}><Search size={22} /></Link>
          <Link to="/app/messages" className="icon-btn" aria-label={t('nav.messages')}><MessageCircle size={22} /></Link>
          <Link to="/app/notifications" className="icon-btn" aria-label={`${t('nav.notifications')}${unread ? `, ${unread} unread` : ''}`}>
            <Bell size={22} />{unread > 0 && <span className="badge" aria-hidden>{unread > 99 ? '99+' : unread}</span>}
          </Link>
        </header>
        <main className="main">
          {!configured && <div className="notice err" role="alert">{t('error.config')}</div>}
          <Outlet />
        </main>
      </div>

      <nav className="bottomnav" aria-label="Primary">
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <n.icon size={22} aria-hidden /> {n.label}
          </NavLink>
        ))}
        <NavLink to={mine} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}><User size={22} aria-hidden /> {t('nav.profile')}</NavLink>
      </nav>
    </div>
  )
}
