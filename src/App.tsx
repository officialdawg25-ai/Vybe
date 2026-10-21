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
const OrderPage = lazy(() => import('./pages/Orders'))
const Earnings = lazy(() => import('./pages/Earnings'))
const Receipt = lazy(() => import('./pages/Receipt'))
const AdminFinance = lazy(() => import('./pages/admin/Finance'))
const MyTickets = lazy(() => import('./pages/MyTickets'))
const Live = lazy(() => import('./pages/Live'))
const LiveRoom = lazy(() => import('./pages/LiveRoom'))
const Moderation = lazy(() => import('./pages/Admin'))
const BrandHero = lazy(() => import('./pages/admin/BrandHero'))
const AdminPortal = lazy(() => import('./portals/AdminPortal').then(m => ({ default: m.AdminPortal })))
const AdminOnly = lazy(() => import('./portals/AdminPortal').then(m => ({ default: m.AdminOnly })))
const OrgPortal = lazy(() => import('./portals/OrgPortal').then(m => ({ default: m.OrgPortal })))
const OrgList = lazy(() => import('./portals/OrgPortal').then(m => ({ default: m.OrgList })))
const OrgDashboard = lazy(() => import('./portals/OrgPortal').then(m => ({ default: m.OrgDashboard })))
const CreatePost = lazy(() => import('./pages/CreatePost'))
const MemoryCreate = lazy(() => import('./pages/MemoryCreate'))
const MemoryViewer = lazy(() => import('./pages/MemoryViewer'))
const Music = lazy(() => import('./pages/Music'))
const EditProfile = lazy(() => import('./pages/profile/EditProfile'))
const ChatSecurity = lazy(() => import('./pages/profile/ChatSecurity'))
const ProfileSettings = lazy(() => import('./pages/profile/ProfileSettings'))
const FollowSettings = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.FollowSettings })))
const HighlightsPage = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.HighlightsPage })))
const ArchivePage = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.ArchivePage })))
const ViewAsPage = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.ViewAsPage })))
const ManagePosts = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.ManagePosts })))
const ReviewTags = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.ReviewTags })))
const PrivacyCenter = lazy(() => import('./pages/profile/ProfileSettings').then(m => ({ default: m.PrivacyCenter })))
const VerifiedPage = lazy(() => import('./pages/profile/Verified'))
const AdminMusic = lazy(() => import('./pages/admin/Music'))
const AdminVerification = lazy(() => import('./pages/admin/Verification'))
const People = lazy(() => import('./pages/People'))
const Privacy = lazy(() => import('./pages/Privacy'))

const AdminDiscover = lazy(() => import('./pages/admin/Discover'))
const OrgPage = lazy(() => import('./pages/OrgPage'))
const Promos = lazy(() => import('./pages/admin/Promos'))

function AdminMusicPage() {
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Music library</h1>
      <p className="t-meta" style={{ marginBottom: 16 }}>Songs members can attach to posts</p>
      <AdminMusic />
    </>
  )
}

function AdminVerificationPage() {
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>VYBE Verified</h1>
      <p className="t-meta" style={{ marginBottom: 16 }}>Plans, prices and the badge</p>
      <AdminVerification />
    </>
  )
}

function DiscoverAdminPage() {
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Discover</h1>
      <p className="t-meta" style={{ marginBottom: 16 }}>Categories and maps</p>
      <AdminDiscover />
    </>
  )
}

function PromosPage() {
  return (
    <>
      <h1 className="t-title" style={{ marginBottom: 4 }}>Home billboard</h1>
      <p className="t-meta" style={{ marginBottom: 16 }}>Brand &amp; Experience</p>
      <Promos />
    </>
  )
}

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
        {/* Full-screen experiences render outside the app shell (no header or tab bar). */}
        <Route path="/app/create" element={<RequireAuth><CreatePost /></RequireAuth>} />
        <Route path="/app/people" element={<RequireAuth><People /></RequireAuth>} />
        <Route path="/app/memories/new" element={<RequireAuth><MemoryCreate /></RequireAuth>} />
        <Route path="/app/memories/:authorId" element={<RequireAuth><MemoryViewer /></RequireAuth>} />
        <Route path="/app" element={<RequireAuth><Shell /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="discover" element={<Discover />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="search" element={<Search />} />
          <Route path="friends" element={<Friends />} />
          <Route path="plans" element={<Plans />} />
          <Route path="plans/:id" element={<PlanDetail />} />
          <Route path="pages/:slug" element={<OrgPage />} />
          <Route path="music" element={<Music />} />
          <Route path="profile/edit" element={<EditProfile />} />
          <Route path="profile/settings" element={<ProfileSettings />} />
          <Route path="profile/settings/follow" element={<FollowSettings />} />
          <Route path="profile/settings/highlights" element={<HighlightsPage />} />
          <Route path="profile/settings/archive" element={<ArchivePage />} />
          <Route path="profile/settings/view-as" element={<ViewAsPage />} />
          <Route path="profile/settings/posts" element={<ManagePosts />} />
          <Route path="profile/settings/tags" element={<ReviewTags />} />
          <Route path="profile/settings/privacy" element={<PrivacyCenter />} />
          <Route path="profile/settings/verified" element={<VerifiedPage />} />
          <Route path="communities" element={<Communities />} />
          <Route path="communities/:id" element={<CommunityDetail />} />
          <Route path="messages" element={<Messages />} />
          <Route path="messages/:id" element={<Messages />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="posts/:id" element={<PostPage />} />
          <Route path="u/:username" element={<ProfilePage />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/chat-security" element={<ChatSecurity />} />
          <Route path="live" element={<Live />} />
          <Route path="live/:id" element={<LiveRoom />} />
          <Route path="live/:id/host" element={<LiveRoom host />} />
          <Route path="tickets" element={<MyTickets />} />
          <Route path="orders/:id" element={<OrderPage />} />
          <Route path="orders/:id/receipt" element={<Receipt />} />
          <Route path="earnings" element={<Earnings />} />
          <Route path="organizations" element={<Navigate to="/org" replace />} />
          <Route path="admin" element={<Navigate to="/admin" replace />} />
        </Route>
        {/* Separate portals: platform admin (/admin) and organizations (/org); the user portal stays at /app. */}
        <Route path="/admin" element={<RequireAuth><AdminPortal /></RequireAuth>}>
          <Route index element={<Moderation />} />
          <Route path="brand" element={<AdminOnly><BrandPage /></AdminOnly>} />
          <Route path="discover" element={<AdminOnly><DiscoverAdminPage /></AdminOnly>} />
          <Route path="music" element={<AdminOnly><AdminMusicPage /></AdminOnly>} />
          <Route path="verification" element={<AdminOnly><AdminVerificationPage /></AdminOnly>} />
          <Route path="promos" element={<AdminOnly><PromosPage /></AdminOnly>} />
          <Route path="finance" element={<AdminOnly><AdminFinance /></AdminOnly>} />
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
