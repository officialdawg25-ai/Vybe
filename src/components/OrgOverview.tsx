import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAsync } from '../lib/hooks'
import { isMissingSchema } from '../lib/tickets'
import { formatEventTime } from '../lib/format'
import { useAuth } from '../auth/AuthProvider'
import { ErrorState, Spinner, errMsg, toast } from '../ui'

export interface Overview {
  role: string; events_upcoming: number; events_past: number; events_draft: number; going_upcoming: number; members: number; invited: number; followers: number
  posts: number; posts_30d: number; communities?: number; community_members?: number; media?: number; next_event: { id: string; title: string; starts_at: string; timezone: string } | null
  // Owners and admins only (the server leaves them out for editors).
  campaigns?: Record<string, number>; impressions_30d?: number; clicks_30d?: number; tickets_30d?: number
}
export interface Activity { id: number; at: string; action: string; detail: Record<string, unknown>; actor: { username: string; display_name: string } | null }

const notReady = (e: { code?: string; message?: string } | null) => isMissingSchema(e) || e?.code === 'PGRST202'

/** The organisation's numbers, straight from org_overview (aggregates only; nothing is estimated or padded). */
export function OrgOverview({ orgId, slug }: { orgId: string; slug: string }) {
  const o = useAsync(async () => {
    const { data, error } = await supabase.rpc('org_overview', { p_org: orgId })
    if (error) { if (notReady(error)) return null; throw error }
    // Never fill gaps with zeros: a reply without the counts is reported, not shown as an empty organisation.
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof (data as Overview).events_upcoming !== 'number') throw new Error('The overview could not be loaded. Try again.')
    return data as Overview
  }, [orgId])
  if (o.loading && !o.data) return <Spinner />
  if (o.error) return <ErrorState message={o.error} onRetry={o.reload} />
  if (!o.data) return <p className="notice" role="status">The overview needs the latest database update (migration 19).</p>
  const d = o.data
  const tab = (t: string) => `/org/${slug}?tab=${t}`
  const live = d.campaigns?.live ?? 0, waiting = d.campaigns?.submitted ?? 0
  const ctr = d.impressions_30d ? `${((d.clicks_30d ?? 0) / d.impressions_30d * 100).toFixed(1)}%` : '—'
  return (
    <section aria-label="Overview" className="org-ov">
      {d.next_event
        ? <Link to={`/app/plans/${d.next_event.id}`} className="card org-next"><span className="t-meta">Next up</span><b className="t-name">{d.next_event.title}</b><span className="t-meta">{formatEventTime(d.next_event.starts_at, d.next_event.timezone)}</span></Link>
        : <div className="card org-next"><span className="t-meta">Nothing scheduled</span><Link className="btn sm primary" to={tab('events')}>Create an event</Link></div>}
      <ul className="org-stats">
        <Stat label="Upcoming events" value={d.events_upcoming} to={tab('events')} />
        <Stat label="Going to upcoming" value={d.going_upcoming} />
        <Stat label="Past events" value={d.events_past} />
        <Stat label="Drafts" value={d.events_draft} />
        <Stat label="Followers" value={d.followers} />
        <Stat label="Page posts (30 days)" value={d.posts_30d} sub={`${d.posts} in total`} to={tab('posts')} />
        <Stat label="Team" value={d.members} sub={d.invited ? `${d.invited} invited` : undefined} to={tab('members')} />
        {d.communities != null && <Stat label="Communities" value={d.communities} sub={d.community_members ? `${d.community_members} members` : undefined} to={tab('communities')} />}
        {d.media != null && <Stat label="Media library" value={d.media} to={tab('media')} />}
        {d.tickets_30d != null && <Stat label="Tickets sold (30 days)" value={d.tickets_30d} to={tab('finance')} />}
        {d.campaigns && <Stat label="Live campaigns" value={live} sub={waiting ? `${waiting} awaiting review` : undefined} to={tab('campaigns')} />}
        {d.impressions_30d != null && <Stat label="Campaign views (30 days)" value={d.impressions_30d} sub={`${d.clicks_30d ?? 0} taps · ${ctr}`} />}
      </ul>
      <p className="t-meta">Counts come from VYBE’s records: “going” is people who said so, tickets are paid orders, views and taps are recorded when a campaign is on screen or opened.{d.role === 'editor' ? ' Sales and campaign figures are shown to owners and admins.' : ''}</p>
    </section>
  )
}

function Stat({ label, value, sub, to }: { label: string; value: number; sub?: string; to?: string }) {
  const body = <><span className="org-stat-l">{label}</span><span className="org-stat-v">{value.toLocaleString()}</span>{sub && <span className="t-meta">{sub}</span>}</>
  return <li>{to ? <Link to={to} className="org-stat link">{body}</Link> : <div className="org-stat">{body}</div>}</li>
}

const LABEL: Record<string, string> = {
  'org.updated': 'Changed the page', 'org.member_invited': 'Invited a member', 'org.member_added': 'Added a member', 'org.member_active': 'Joined',
  'org.member_removed': 'Removed a member', 'org.role_changed': 'Changed a role', 'org.community_added': 'Brought in a community', 'org.community_removed': 'Let go of a community', 'campaign.submitted': 'Submitted a campaign', 'campaign.live': 'Campaign approved',
  'campaign.rejected': 'Campaign not approved', 'campaign.paused': 'Campaign paused', 'campaign.draft': 'Saved a campaign draft',
}
const FIELD: Record<string, string> = { name: 'name', description: 'about', avatar_path: 'logo', cover_path: 'cover', website: 'website', links: 'links', location: 'location', verified_at: 'verification' }

/** Who changed what, from the audit log (owners and admins). */
export function OrgHistory({ orgId }: { orgId: string }) {
  const h = useAsync(async () => {
    const { data, error } = await supabase.rpc('org_activity', { p_org: orgId, p_limit: 30 })
    if (error) { if (notReady(error)) return null; throw error }
    if (!Array.isArray(data)) throw new Error('The history could not be loaded. Try again.')
    return data as Activity[]
  }, [orgId])
  if (h.loading && !h.data) return <Spinner />
  if (h.error) return <ErrorState message={h.error} onRetry={h.reload} />
  if (!h.data) return <p className="t-meta">History needs the latest database update.</p>
  if (!h.data.length) return <p className="t-meta">No changes recorded yet.</p>
  return (
    <ol className="list org-history" aria-label="Recent changes">
      {h.data.map(a => {
        const fields = Array.isArray(a.detail.fields) ? (a.detail.fields as string[]).map(f => FIELD[f]).filter(Boolean) : []
        return (
          <li key={a.id} className="item">
            <div className="t-name">{LABEL[a.action] ?? a.action}{fields.length ? `: ${fields.join(', ')}` : ''}{a.action === 'org.role_changed' ? ` (${a.detail.from} → ${a.detail.to})` : ''}</div>
            <div className="t-meta">{a.actor ? `@${a.actor.username}` : 'VYBE'} · {new Date(a.at).toLocaleString()}</div>
          </li>
        )
      })}
    </ol>
  )
}


const PREFS: { key: 'members' | 'rsvps' | 'follows' | 'campaigns'; label: string; managersOnly?: boolean }[] = [
  { key: 'rsvps', label: 'Someone is going to one of our events' },
  { key: 'follows', label: 'Someone follows our page' },
  { key: 'members', label: 'Someone joins the team' },
  { key: 'campaigns', label: 'VYBE reviews one of our campaigns', managersOnly: true },
]

/** The signed-in member's own notification choices for this organisation (each member decides for themselves). */
export function OrgNotifPrefs({ orgId, role }: { orgId: string; role: string }) {
  const { uid } = useAuth()
  const [saving, setSaving] = useState<string | null>(null)
  const prefs = useAsync(async () => {
    const { data, error } = await supabase.from('organization_members').select('notif_prefs').eq('organization_id', orgId).eq('user_id', uid!).maybeSingle()
    if (error) { if (notReady(error)) return null; throw error }
    return ((data?.notif_prefs ?? {}) as Record<string, boolean>)
  }, [orgId, uid])
  if (prefs.loading && !prefs.data) return <Spinner />
  if (prefs.error) return <ErrorState message={prefs.error} onRetry={prefs.reload} />
  if (!prefs.data) return <p className="t-meta">Notification settings need the latest database update.</p>
  const manager = role === 'owner' || role === 'admin'
  const on = (k: string) => prefs.data![k] ?? manager                                   // the server's default: on for owners and admins
  const set = async (k: string, v: boolean) => {
    setSaving(k)
    const { error } = await supabase.rpc('set_org_notif_prefs', { p_org: orgId, p_prefs: { [k]: v } })
    setSaving(null)
    if (error) toast(errMsg(error)); else prefs.reload()
  }
  return (
    <fieldset className="org-prefs">
      <legend className="t-section">Your notifications from this organisation</legend>
      {PREFS.filter(p => !p.managersOnly || manager).map(p => (
        <label key={p.key} className="row" style={{ gap: 8, padding: '6px 0' }}>
          <input type="checkbox" checked={on(p.key)} disabled={saving === p.key} onChange={e => void set(p.key, e.target.checked)} />
          <span>{p.label}</span>
        </label>
      ))}
      <p className="t-meta">Only you see these choices. Your account-wide notification settings still apply.</p>
    </fieldset>
  )
}
