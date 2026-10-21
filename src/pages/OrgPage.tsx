import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BadgeCheck, ExternalLink } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Feed } from '../components/Feed'
import { FollowButton } from '../components/discover/FollowButton'
import { ORG_KIND_LABEL, useFollowStats } from '../lib/discover'
import { formatEventTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { fetchPosts } from '../lib/posts'
import { supabase } from '../lib/supabase'
import { Avatar, Empty, ErrorState, Spinner } from '../ui'

interface Org { id: string; name: string; slug: string; kind: string; description: string; avatar_path: string | null; verified_at: string | null }
interface Ev { id: string; title: string; starts_at: string; timezone: string; venue: string | null; city: string | null; format: string }

/** Public page for an artist, venue or organiser: who they are, a Follow button, what is coming up and what they posted. */
export default function OrgPage() {
  const { slug } = useParams()
  const { uid } = useAuth()
  const org = useAsync(async () => {
    const { data, error } = await supabase.from('organizations').select('id,name,slug,kind,description,avatar_path,verified_at').ilike('slug', slug!).maybeSingle()
    if (error) throw error
    return data as Org | null
  }, [slug])
  const stats = useFollowStats('organization', org.data?.id ?? '00000000-0000-0000-0000-000000000000')
  const events = useAsync(async () => {
    if (!org.data) return [] as Ev[]
    const { data, error } = await supabase.from('events').select('id,title,starts_at,timezone,venue,city,format').eq('organization_id', org.data.id).eq('status', 'active').gte('starts_at', new Date().toISOString()).order('starts_at').limit(20)
    if (error) throw error
    return (data ?? []) as Ev[]
  }, [org.data?.id])
  useEffect(() => { document.title = org.data ? `${org.data.name} · VYBE` : 'Page · VYBE' }, [org.data])

  if (org.loading) return <Spinner />
  if (org.error) return <ErrorState message={org.error} onRetry={org.reload} />
  const o = org.data
  if (!o) return <Empty title="Page not found">It may have been removed or the link is wrong.</Empty>
  return (
    <>
      <header className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <Avatar path={o.avatar_path} name={o.name} size="lg" kind="org" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 className="t-title">{o.name}{o.verified_at && <BadgeCheck size={20} aria-label="Verified by VYBE" style={{ marginLeft: 6, color: 'var(--brand)', verticalAlign: '-3px' }} />}</h1>
          <p className="t-meta">{ORG_KIND_LABEL[o.kind] ?? o.kind}{stats.data ? ` · ${stats.data.followers} ${stats.data.followers === 1 ? 'follower' : 'followers'}` : ''}</p>
        </div>
        <FollowButton type="organization" id={o.id} following={Boolean(stats.data?.following)} onChange={() => stats.reload()} size="md" label={o.name} />
      </header>
      {o.description && <p style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>{o.description}</p>}
      <section aria-labelledby="op-ev" style={{ marginBottom: 24 }}>
        <h2 id="op-ev" className="t-section">Upcoming</h2>
        {events.loading ? <Spinner /> : events.error ? <ErrorState message={events.error} onRetry={events.reload} /> : !events.data?.length ? <p className="t-support" style={{ padding: '8px 0' }}>Nothing scheduled right now. Follow to hear when {o.name} publishes something.</p> : (
          <div className="list">{events.data.map(e => (
            <Link key={e.id} to={`/app/plans/${e.id}`} className="item link" style={{ display: 'block', padding: '12px 4px' }}>
              <div className="t-meta" style={{ color: 'var(--brand)', fontWeight: 600 }}>{formatEventTime(e.starts_at, e.timezone)}</div>
              <div className="t-name">{e.title}</div>
              <div className="t-meta clamp-1">{e.format === 'online' ? 'Online' : [e.venue, e.city].filter(Boolean).join(', ') || 'Location to be announced'}</div>
            </Link>))}</div>
        )}
      </section>
      <section aria-labelledby="op-posts">
        <h2 id="op-posts" className="t-section">Posts</h2>
        <Feed load={cursor => fetchPosts({ uid: uid!, cursor, organizationId: o.id })} deps={[o.id]} empty={{ title: 'No posts yet', text: 'Updates from this page will appear here.' }} />
      </section>
      <p className="t-meta" style={{ marginTop: 16 }}><Link to="/app/discover?mode=artists">Back to artists &amp; venues</Link> · <a href={`/app/pages/${o.slug}`} aria-label="Permalink" style={{ textDecoration: 'underline' }}>Permalink <ExternalLink size={12} aria-hidden /></a></p>
    </>
  )
}
