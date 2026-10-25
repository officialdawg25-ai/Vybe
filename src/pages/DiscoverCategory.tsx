import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { useChromeless } from '../lib/chrome'
import { loadCategories } from '../lib/discover'
import { useAsync } from '../lib/hooks'
import { buildTiles, useTileMedia } from '../lib/tiles'
import { LiveList } from '../components/discover/LiveList'
import { OrgList } from '../components/discover/OrgList'
import { ResultsView } from '../components/discover/ResultsView'
import { LocationControl, useDiscoverScope } from '../components/discover/Scope'
import { Spinner } from '../ui'
import { CommunityBrowse } from './Discover'

/**
 * One Discover category on its own screen: a cover band with the category's picture or video (chosen by admins), then
 * search, place and a single row of "when" choices, then the results. Everything else lives behind Filters, and Map opens
 * the full-screen map. Nothing is pre-selected: the screen shows exactly the category that was tapped.
 */
export default function DiscoverCategory() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { profile } = useAuth()
  const all = useAsync(loadCategories, [])
  const media = useTileMedia()
  const s = useDiscoverScope(profile)
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useChromeless()
  useEffect(() => { const t = setTimeout(() => setDq(q.trim().length >= 2 ? q.trim() : ''), 300); return () => clearTimeout(t) }, [q])

  const cats = (all.data ?? []).filter(c => c.active)
  const tile = buildTiles(cats).find(t => t.id === id)
  useEffect(() => { if (tile) document.title = `${tile.label} · Discover · VYBE` }, [tile?.label])
  if (all.loading && !all.data) return <Spinner />
  if (!tile) return <Navigate to="/app/discover" replace />

  const m = media.get(tile.id)
  const cat = cats.find(c => c.slug === tile.id)
  const group = tile.id === 'music' || cat?.group_key === 'concerts' ? 'concerts' : 'events'
  const Icon = tile.icon
  const back = () => (window.history.length > 1 ? nav(-1) : nav('/app/discover'))

  return (
    <div className="dcat" style={{ ['--tile' as string]: tile.accent }}>
      <header className={`dcat-hero${m ? ' has-art' : ''}`} style={m && !m.video ? { backgroundImage: `url(${m.url})` } : undefined}>
        {m?.video && <video className="dcat-video" src={m.url} muted loop autoPlay playsInline aria-hidden />}
        <button className="icon-btn dcat-back" aria-label="Back to Discover" onClick={back}><ArrowLeft size={22} /></button>
        <div className="dcat-copy">
          <span className="dcat-ico" aria-hidden><Icon size={24} /></span>
          <h1>{tile.label}</h1>
          <p>{tile.blurb}</p>
        </div>
      </header>
      <div className="dcat-controls">
        <form role="search" aria-label={`Search ${tile.label}`} className="dsearch" onSubmit={e => e.preventDefault()}>
          <Search size={20} aria-hidden />
          <input type="search" aria-label="Search" value={q} onChange={e => setQ(e.target.value)}
            placeholder={tile.kind === 'artists' ? 'Search artists, venues, organisers' : tile.kind === 'communities' ? 'Search communities' : `Search ${tile.label.toLowerCase()}`} />
        </form>
        {tile.kind === 'events' && <LocationControl s={s} />}
      </div>
      {tile.kind === 'artists' ? <OrgList q={dq} />
        : tile.kind === 'communities' ? <CommunityBrowse q={dq} topic="" />
        : tile.kind === 'live' ? <LiveList />
        : <ResultsView key={tile.id} group={group} q={dq} scope={s.scope} title={tile.label}
            preset={{ categories: cat ? [cat.slug] : undefined, format: tile.id === 'online' ? 'online' : undefined }} />}
    </div>
  )
}
