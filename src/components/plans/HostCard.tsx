import { Link } from 'react-router-dom'
import { BadgeCheck, CalendarCheck2, ShieldCheck, Star, UsersRound } from 'lucide-react'
import { useAsync } from '../../lib/hooks'
import { supabase } from '../../lib/supabase'
import { isMissingSchema } from '../../lib/tickets'
import { Avatar } from '../../ui'
import { FollowButton } from '../discover/FollowButton'

interface Rep { member_since: string; verified: boolean; plans: number; past_plans: number; cancelled: number; people_went: number; reviews: number; rating: number | null; approved_for_sales: boolean; followers: number | null }
interface Host { id: string; username: string; display_name: string; avatar_path: string | null }
interface Org { id: string; name: string; slug: string; verified_at: string | null }

const since = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/**
 * "Hosted by", as a reason to trust: what the host has done on VYBE (from host_reputation, counted only over plans this
 * viewer may see), the checks VYBE did, and one clear Follow. Nothing here is self-declared by the host.
 */
export function HostCard({ host, isHost, following, onFollow, salesApproved, org, orgFollowing, onOrgFollow }: {
  host: Host; isHost: boolean; following: boolean; onFollow: () => void; salesApproved: boolean
  org?: Org | null; orgFollowing?: boolean; onOrgFollow?: () => void
}) {
  const rep = useAsync(async () => {
    const { data, error } = await supabase.rpc('host_reputation', { p_host: host.id })
    if (error) { if (isMissingSchema(error) || /could not find the function/i.test(error.message)) return null; throw error }
    return data as Rep | null
  }, [host.id, following])
  const r = rep.data
  const name = host.display_name || host.username
  const stats: { k: string; v: string; icon: typeof Star }[] = r ? [
    { k: r.plans === 1 ? 'plan hosted' : 'plans hosted', v: compact(r.plans), icon: CalendarCheck2 },
    ...(r.people_went ? [{ k: 'people went', v: compact(r.people_went), icon: UsersRound }] : []),
    ...(r.rating != null ? [{ k: `${r.reviews} reviews`, v: `★ ${r.rating}`, icon: Star }] : []),
    ...(r.followers != null ? [{ k: r.followers === 1 ? 'follower' : 'followers', v: compact(r.followers), icon: UsersRound }] : []),
  ] : []
  const chips = [
    r?.verified && { t: 'Verified on VYBE', icon: BadgeCheck },
    (salesApproved || r?.approved_for_sales) && { t: 'Checked by VYBE for ticket sales', icon: ShieldCheck },
    r && r.past_plans > 0 && r.cancelled === 0 && { t: 'No cancelled plans', icon: CalendarCheck2 },
  ].filter(Boolean) as { t: string; icon: typeof Star }[]
  return (
    <section className="host-card" aria-label="Hosted by">
      <div className="host-head">
        <Link to={`/app/u/${host.username}`} className="host-ava" aria-label={`${name}'s profile`}>
          <Avatar path={host.avatar_path} uid={host.id} name={name} />
          {r?.verified && <span className="host-tick" aria-hidden><BadgeCheck size={16} /></span>}
        </Link>
        <div className="grow">
          <span className="t-meta">Hosted by</span>
          <Link to={`/app/u/${host.username}`} className="host-name">{name}</Link>
          <span className="t-meta">@{host.username}{r ? ` · on VYBE since ${since(r.member_since)}` : ''}</span>
        </div>
        {!isHost && <FollowButton type="profile" id={host.id} following={following} onChange={onFollow} size="md" label={name} className="host-follow" />}
      </div>
      {stats.length > 0 && <div className="host-stats">{stats.map(s => <div key={s.k}><b>{s.v}</b><span>{s.k}</span></div>)}</div>}
      {chips.length > 0 && <div className="host-chips">{chips.map(c => <span key={c.t} className="host-chip"><c.icon size={14} aria-hidden /> {c.t}</span>)}</div>}
      {!isHost && !following && r && <p className="host-nudge">Follow {name.split(' ')[0]} to hear about their next plan first.</p>}
      {org && (
        <div className="host-org">
          <span className="grow"><span className="t-meta">Presented by</span> <Link to={`/app/pages/${org.slug}`}><b>{org.name}</b></Link>{org.verified_at && <BadgeCheck size={14} aria-label="Verified by VYBE" style={{ marginLeft: 4, color: 'var(--brand)', verticalAlign: '-2px' }} />}</span>
          {onOrgFollow && <FollowButton type="organization" id={org.id} following={Boolean(orgFollowing)} onChange={onOrgFollow} label={org.name} />}
        </div>
      )}
    </section>
  )
}
