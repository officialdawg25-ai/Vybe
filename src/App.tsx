import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { RequireAuth } from './auth/AuthProvider'
import { Shell } from './Shell'
import { Spinner } from './ui'
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
const Organizations = lazy(() => import('./pages/Organizations'))
const Admin = lazy(() => import('./pages/Admin'))
const Privacy = lazy(() => import('./pages/Privacy'))

export function App() {
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
          <Route path="organizations" element={<Organizations />} />
          <Route path="admin" element={<Admin />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
