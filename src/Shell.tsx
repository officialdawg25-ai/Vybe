import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bell, UserPlus, Wallet, Ticket, CalendarDays, Compass, Home, LogOut, MessageCircle, Radio, Search, Settings, Shield, Building2, Users, UsersRound } from 'lucide-react'
import { useAuth } from './auth/AuthProvider'
import { configProblem, configured, supabase } from './lib/supabase'
import { signOutThisTab } from './lib/session'
import { t } from './lib/i18n'
import { Lockup } from './brand/Logo'
import { playSound } from './lib/sounds'
import { Avatar, Popover, ThemeButton } from './ui'
import { CallProvider } from './components/CallProvider'

/** Primary destinations: the same set in the header (desktop), sidebar and bottom bar (mobile). */
const NAV = [
  { to: '/app', end: true, icon: Home, label: t('nav.home') },
  { to: '/app/discover', icon: Compass, label: t('nav.discover') },
  { to: '/app/friends', icon: Users, label: t('nav.friends') },
  { to: '/app/plans', icon: CalendarDays, label: t('nav.plans') },
  { to: '/app/communities', icon: UsersRound, label: t('nav.communities') },
] as const

/** Routes whose pages compose their own columns (feed + side column) and so need the wide content area. */
export const isWideRoute = (path: string) => /^\/app\/?$/.test(path) || /^\/app\/discover\/?$/.test(path)

/** Unread notification count, kept current via Realtime (RLS limits events to the user's own rows). */
function useUnread(uid: string | null) {
  const [n, setN] = useState(0)
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!uid) return
    const count = async () => {
      const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
      const next = count ?? 0
      // Chime only when something new arrives after the first load.
      if (last.current !== null && next > last.current) playSound('notify')
      last.current = next
      setN(next)
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

/**
 * Unread chat messages (capped at 100). One cheap RPC; refreshed when the tab is focused, after reading a chat, and every
 * 25 s while visible. (Realtime on every message would not scale to a large audience, so the badge polls with jitter.)
 */
function useUnreadMessages(uid: string | null) {
  const [n, setN] = useState(0)
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!uid) return
    let live = true
    const count = async () => {
      if (document.visibilityState === 'hidden') return
      const { data, error } = await supabase.rpc('unread_messages')
      if (!live || error) return                                             // before the migration, or offline: show nothing
      const next = Number(data) || 0
      if (last.current !== null && next > last.current) playSound('notify')
      last.current = next; setN(next)
    }
    void count()
    const t = window.setInterval(count, 25_000 + Math.floor(Math.random() * 5_000))
    window.addEventListener('focus', count); window.addEventListener('vybe:messages', count); document.addEventListener('visibilitychange', count)
    return () => { live = false; window.clearInterval(t); window.removeEventListener('focus', count); window.removeEventListener('vybe:messages', count); document.removeEventListener('visibilitychange', count) }
  }, [uid])
  return n
}

const cls = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? ' active' : ''}`

function HeaderSearch() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const submit = (e: FormEvent) => { e.preventDefault(); const v = q.trim(); if (v.length >= 2) { nav(`/app/search?q=${encodeURIComponent(v)}`); setQ('') } }
  return (
    <form className="hdr-search" role="search" aria-label="Site search" onSubmit={submit}>
      <Search size={18} aria-hidden />
      <input type="search" aria-label="Search VYBE" placeholder="Search VYBE" value={q} onChange={e => setQ(e.target.value)} />
    </form>
  )
}

function AccountMenu({ mine }: { mine: string }) {
  const { profile } = useAuth()
  const nav = useNavigate()
  const staff = useStaff()
  const name = profile?.display_name || profile?.username || 'Account'
  const signOut = async () => { if (await signOutThisTab()) nav('/', { replace: true }) }
  return (
    <Popover label="Account menu" trigger={<Avatar path={profile?.avatar_path} name={name} size="sm" />}>
      <Link to={mine} role="menuitem" className="pop-item pop-who">
        <Avatar path={profile?.avatar_path} name={name} />
        <span className="grow"><span className="t-name clamp-1" style={{ display: 'block' }}>{name}</span><span className="t-meta">View your profile</span></span>
      </Link>
      <div className="pop-sep" role="separator" />
      <Link to="/app/tickets" role="menuitem" className="pop-item"><Ticket size={20} aria-hidden /> My tickets</Link>
      <Link to="/app/earnings" role="menuitem" className="pop-item"><Wallet size={20} aria-hidden /> Earnings</Link>
      <Link to="/app/live" role="menuitem" className="pop-item"><Radio size={20} aria-hidden /> Live</Link>
      <Link to="/org" role="menuitem" className="pop-item"><Building2 size={20} aria-hidden /> Organization portal</Link>
      <Link to="/app/settings" role="menuitem" className="pop-item"><Settings size={20} aria-hidden /> {t('nav.settings')}</Link>
      {staff && <Link to="/admin" role="menuitem" className="pop-item"><Shield size={20} aria-hidden /> Admin portal</Link>}
      <ThemeButton menu />
      <div className="pop-sep" role="separator" />
      <a role="menuitem" className="pop-item" href="/signin?account=new" target="_blank" rel="noopener"><UserPlus size={20} aria-hidden /> Use another account in a new tab</a>
      <button role="menuitem" className="pop-item" onClick={signOut}><LogOut size={20} aria-hidden /> Sign out</button>
    </Popover>
  )
}

function useStaff() {
  const { uid } = useAuth()
  const [staff, setStaff] = useState(false)
  useEffect(() => { if (uid) supabase.rpc('is_staff').then(({ data }) => setStaff(Boolean(data))) }, [uid])
  return staff
}

export function Shell() {
  const { uid, profile } = useAuth()
  const unread = useUnread(uid)
  const unreadChats = useUnreadMessages(uid)
  const { pathname } = useLocation()
  const mine = profile ? `/app/u/${profile.username}` : '/app/settings'
  const wide = isWideRoute(pathname)
  const unreadLabel = unread ? `, ${unread} unread` : ''
  return (
    <CallProvider>
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <header className="hdr">
        <div className="hdr-in">
          <div className="hdr-left">
            <Link to="/app" className="hdr-logo" aria-label="VYBE home"><Lockup height={18} /></Link>
            <HeaderSearch />
          </div>
          <nav className="hdr-nav" aria-label="Primary">
            {NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={'end' in n} className={cls} aria-label={n.label} title={n.label}>
                <n.icon size={24} aria-hidden />
              </NavLink>
            ))}
          </nav>
          <div className="hdr-right">
            <Link to="/app/search" className="icon-btn hdr-search-btn" aria-label={t('nav.search')}><Search size={22} /></Link>
            <Link to="/app/messages" className="icon-btn" aria-label={`${t('nav.messages')}${unreadChats ? `, ${unreadChats} unread` : ''}`}>
              <MessageCircle size={22} />{unreadChats > 0 && <span className="badge" aria-hidden>{unreadChats > 99 ? '99+' : unreadChats}</span>}
            </Link>
            <Link to="/app/notifications" className="icon-btn" aria-label={`${t('nav.notifications')}${unreadLabel}`}>
              <Bell size={22} />{unread > 0 && <span className="badge" aria-hidden>{unread > 99 ? '99+' : unread}</span>}
            </Link>
            <AccountMenu mine={mine} />
          </div>
        </div>
      </header>

      <div className="shell-body">
        <nav className="side" aria-label="Shortcuts">
          <NavLink to={mine} className={cls}><Avatar path={profile?.avatar_path} name={profile?.display_name || profile?.username || '?'} size="sm" /> {profile?.display_name || t('nav.profile')}</NavLink>
          {NAV.map(n => <NavLink key={n.to} to={n.to} end={'end' in n} className={cls}><n.icon size={22} aria-hidden /> {n.label}</NavLink>)}
          <div className="side-sep" role="separator" />
          <NavLink to="/app/tickets" className={cls}><Ticket size={22} aria-hidden /> My tickets</NavLink>
          <NavLink to="/app/messages" className={cls}><MessageCircle size={22} aria-hidden /> {t('nav.messages')}{unreadChats > 0 && <span className="badge">{unreadChats > 99 ? '99+' : unreadChats}</span>}</NavLink>
          <NavLink to="/app/notifications" className={cls}><Bell size={22} aria-hidden /> {t('nav.notifications')}{unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}</NavLink>
          <NavLink to="/app/live" className={cls}><Radio size={22} aria-hidden /> Live</NavLink>
          <Link to="/org" className="nav-link"><Building2 size={22} aria-hidden /> Organization portal</Link>
          <NavLink to="/app/settings" className={cls}><Settings size={22} aria-hidden /> {t('nav.settings')}</NavLink>
        </nav>
        <main id="main" className={`main${wide ? ' wide' : ''}`} tabIndex={-1}>
          {!configured && <div className="notice err" role="alert">{configProblem()}</div>}
          <Outlet />
        </main>
      </div>

      <nav className="bottomnav" aria-label="Primary">
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={'end' in n} className={cls}><n.icon size={22} aria-hidden /> <span>{n.label}</span></NavLink>
        ))}
      </nav>
    </div>
    </CallProvider>
  )
}

