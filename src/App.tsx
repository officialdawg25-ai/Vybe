import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth/AuthProvider'
import { Shell } from './Shell'
import { Spinner } from './ui'
import { useTheme } from './lib/theme'
import { SplashGate } from './brand/Splash'

const Landing = lazy(() => import('./pages/Landing'))
const AuthPages = lazy(() => import('./pages/Auth'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const Home = lazy(() => import('./pages/Home'))
const Discover = lazy(() => import('./pages/Discover'))
const Search = lazy(() => import('./pages/Search'))
const Friends = lazy(() => import('./pages/Friends'))
const Plans = lazy(() => import('./pages/Plans'))
const PlanDetail = lazy(() => import('./pages/PlanDetail'))
const Communities = lazy(() => import('./pages/Communities'))
const CommunityDetail = lazy(() => import('./pages/CommunityDetail'))
const Messages = lazy(() => import('./pages/Messages'))
const Notifications = lazy(() => import('./pages/Notifications'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const Settings = lazy(() => import('./pages/Settings'))
const PostPage = lazy(() => import('./pages/PostPage'))
const Live = lazy(() => import('./pages/Live'))
const Moderation = lazy(() => import('./pages/Admin'))
const BrandHero = lazy(() => import('./pages/admin/BrandHero'))
const AdminPortal = lazy(() => import('./portals/AdminPortal').then(m => ({ default: m.AdminPortal })))
const AdminOnly = lazy(() => import('./portals/AdminPortal').then(m => ({ default: m.AdminOnly })))
const OrgPortal = lazy(() => import('./portals/OrgPortal').then(m => ({ default: m.OrgPortal })))
const OrgList = lazy(() => import('./portals/OrgPortal').then(m => ({ default: m.OrgList })))
const OrgDashboard = lazy(() => import('./portals/OrgPortal').then(m => ({ default: m.OrgDashboard })))
const Privacy = lazy(() => import('./pages/Privacy'))

function BrandPage() {
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Authentication hero</h1>
      <p className="t-meta" style={{ marginBottom: 16 }}>Brand &amp; Experience</p>
      <BrandHero />
    </>
  )
}

export function App() {
  useTheme()
  return (
    <Suspense fallback={<Spinner />}>
      <SplashGate />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/signin" element={<AuthPages mode="signin" />} />
        <Route path="/signup" element={<AuthPages mode="signup" />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/forgot" element={<AuthPages mode="forgot" />} />
        <Route path="/reset" element={<AuthPages mode="reset" />} />
        <Route path="/app" element={<RequireAuth><Shell /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="discover" element={<Discover />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="search" element={<Search />} />
          <Route path="friends" element={<Friends />} />
          <Route path="plans" element={<Plans />} />
          <Route path="plans/:id" element={<PlanDetail />} />
          <Route path="communities" element={<Communities />} />
          <Route path="communities/:id" element={<CommunityDetail />} />
          <Route path="messages" element={<Messages />} />
          <Route path="messages/:id" element={<Messages />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="posts/:id" element={<PostPage />} />
          <Route path="u/:username" element={<ProfilePage />} />
          <Route path="settings" element={<Settings />} />
          <Route path="live" element={<Live />} />
          <Route path="organizations" element={<Navigate to="/org" replace />} />
          <Route path="admin" element={<Navigate to="/admin" replace />} />
        </Route>
        {/* Separate portals: platform admin (/admin) and organizations (/org); the user portal stays at /app. */}
        <Route path="/admin" element={<RequireAuth><AdminPortal /></RequireAuth>}>
          <Route index element={<Moderation />} />
          <Route path="brand" element={<AdminOnly><BrandPage /></AdminOnly>} />
        </Route>
        <Route path="/org" element={<RequireAuth><OrgPortal /></RequireAuth>}>
          <Route index element={<OrgList />} />
          <Route path=":slug" element={<OrgDashboard />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
