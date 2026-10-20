import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Pause, Play, Search } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { OrgRow } from '../components/discover/OrgList'
import { TrackArt, useTrackPlayer } from './create/pickers'
import { discoverOrgs } from '../lib/discover'
import { musicCatalog, setTrackSaved, type Track } from '../lib/social'
import { useAsync } from '../lib/hooks'
import { Empty, ErrorState, Spinner, errMsg, toast } from '../ui'

/** Music: artists to follow and songs from the VYBE library. Songs can be previewed, saved, and attached to a post. No catalogue is scraped: songs are added by VYBE admins who hold the rights. */
export default function Music() {
  const { uid } = useAuth()
  const [tab, setTab] = useState<'foryou' | 'trending' | 'saved'>('foryou')
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [playing, toggle] = useTrackPlayer()
  useEffect(() => { document.title = 'Music · VYBE' }, [])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const artists = useAsync(() => discoverOrgs({ kinds: ['artist', 'creator'], q: dq, limit: 12 }), [dq])
  const songs = useAsync(() => musicCatalog(tab, dq), [tab, dq])
  const save = async (t: Track) => { try { await setTrackSaved(t.id, uid!, !t.saved); songs.reload() } catch (e) { toast(errMsg(e)) } }
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}><Link className="icon-btn" to="/app" aria-label="Back to Home"><ArrowLeft size={22} /></Link><h1 className="t-display-sm">Discover music</h1></div>
      <label className="cp-search"><Search size={18} aria-hidden /><input type="search" aria-label="Search artists and songs" placeholder="Search artists and songs" value={q} onChange={e => setQ(e.target.value)} /></label>

      <section className="d-sec" aria-labelledby="mu-art"><div className="row between"><h2 id="mu-art" className="t-section">Artists</h2><Link to="/app/discover?mode=artists" className="t-meta">All artists &amp; venues</Link></div>
        {artists.loading && !artists.data ? <Spinner /> : artists.error ? <ErrorState message={artists.error} onRetry={artists.reload} /> : !artists.data?.length
          ? <p className="t-support" style={{ padding: '8px 0' }}>{dq ? `No artists match “${dq}”.` : 'No artist pages yet. Artists create a page in the organisation portal and show up here.'}</p>
          : <ul className="org-list">{artists.data.map(o => <OrgRow key={o.id} o={o} />)}</ul>}
      </section>

      <section className="d-sec" aria-labelledby="mu-songs"><h2 id="mu-songs" className="t-section">Songs</h2>
        <div className="cp-tabs" role="tablist" aria-label="Song lists">
          {([['foryou', 'For you'], ['trending', 'Trending'], ['saved', 'Saved']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`cp-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {songs.loading && !songs.data ? <Spinner /> : songs.error ? <ErrorState message={songs.error} onRetry={songs.reload} /> : !songs.data?.length
          ? <Empty title={songs.data === null ? 'Music needs the latest update' : tab === 'saved' ? 'No saved songs' : dq ? 'No songs found' : 'The library is empty for now'}>{tab === 'saved' ? 'Save songs to find them here and in the post composer.' : 'Songs appear here when VYBE adds them. You can still tell people what you’re listening to when you post.'}</Empty>
          : <ul className="cp-list">{songs.data.map(t => (
            <li key={t.id} className="cp-row">
              <TrackArt path={t.artwork_path} /><span className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-1" style={{ display: 'block' }}>{t.title}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{t.artist}</span></span>
              {t.preview_path && <button className="icon-btn round" aria-label={playing === t.id ? `Pause ${t.title}` : `Play a preview of ${t.title}`} onClick={() => toggle(t)}>{playing === t.id ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>}
              {t.external_url && <a className="icon-btn round" href={t.external_url} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Listen to ${t.title} on its own page`}><ExternalLink size={18} /></a>}
              <button className="btn sm ghost" aria-pressed={t.saved} onClick={() => save(t)}>{t.saved ? 'Saved' : 'Save'}</button>
              <Link className="btn sm" to={`/app/create?track=${t.id}`}>Post</Link>
            </li>))}</ul>}
      </section>
    </>
  )
}
