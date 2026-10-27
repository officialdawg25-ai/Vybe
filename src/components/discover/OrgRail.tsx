import { Link } from 'react-router-dom'
import { BadgeCheck } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { discoverOrgs, ORG_KIND_LABEL, type OrgCard } from '../../lib/discover'
import { useAsync } from '../../lib/hooks'
import { useSigned } from '../../ui'
import { FollowButton } from './FollowButton'

type WithArt = OrgCard & { cover_path?: string | null; location?: string | null }

/**
 * One horizontal rail per kind of page (Artists, Venues, Organisers…). Each card is the page's own cover (or logo) with
 * its name, kind, place and real counts on it, and a Follow button. Hidden when there is nothing of that kind yet.
 */
export function OrgRail({ title, kinds, seeAll }: { title: string; kinds: string[]; seeAll: () => void }) {
  const list = useAsync(async () => {
    const rows = (await discoverOrgs({ kinds, limit: 12 }).catch(() => null)) ?? []
    if (!rows.length) return [] as WithArt[]
    // Covers and place (organisation identity, migration 19). Older servers simply have none.
    const { data } = await supabase.from('organizations').select('id,cover_path,location').in('id', rows.map(r => r.id))
    const extra = new Map(((data ?? []) as { id: string; cover_path: string | null; location: string | null }[]).map(x => [x.id, x]))
    return rows.map(r => ({ ...r, ...(extra.get(r.id) ?? {}) })) as WithArt[]
  }, [kinds.join(',')])
  if (!list.data?.length) return null
  return (
    <section className="d-sec" aria-label={title}>
      <div className="row between"><h2 className="t-section">{title}</h2><button className="linklike t-meta" onClick={seeAll}>See all</button></div>
      <ul className="hscroll org-rail">{list.data.map(o => <li key={o.id}><OrgTile o={o} /></li>)}</ul>
    </section>
  )
}

export function OrgTile({ o }: { o: WithArt }) {
  const cover = useSigned(o.cover_path ?? null)
  const logo = useSigned(o.avatar_path)
  const art = cover ?? logo
  return (
    <article className="org-tile">
      <Link to={`/app/pages/${o.slug}`} className="org-tile-art" style={art ? { backgroundImage: `url(${art})` } : undefined} aria-label={`${o.name}, ${ORG_KIND_LABEL[o.kind] ?? o.kind}`}>
        {!art && <span className="poster-initial" aria-hidden>{o.name.charAt(0).toUpperCase()}</span>}
        {cover && logo && <span className="org-tile-logo" style={{ backgroundImage: `url(${logo})` }} aria-hidden />}
      </Link>
      <Link to={`/app/pages/${o.slug}`} className="pc" tabIndex={-1} aria-hidden>
        <span className="pc-kicker">{ORG_KIND_LABEL[o.kind] ?? o.kind}</span>
        <span className="pc-title clamp-2">{o.name}{o.verified && <BadgeCheck size={14} aria-label="Verified by VYBE" style={{ marginLeft: 4, verticalAlign: '-2px' }} />}</span>
        <span className="pc-by clamp-1">@{o.slug}</span>
        <span className="pc-meta clamp-1">{o.location ? `${o.location} · ` : ''}{o.upcoming ? <b>{o.upcoming} upcoming</b> : 'Nothing scheduled'} · {o.followers} {o.followers === 1 ? 'follower' : 'followers'}</span>
      </Link>
      <div className="org-tile-act"><FollowButton type="organization" id={o.id} following={o.following} label={o.name} /></div>
    </article>
  )
}
