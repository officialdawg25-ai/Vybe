import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, Bookmark, CalendarDays, Clapperboard, ExternalLink, FolderOpen, Info, MoreVertical, Music2, Pause, Play, Plus, Search, Share2, Sparkles, SquarePen } from 'lucide-react'
import { validateSong, titleFromFile } from '../lib/media'
import { useAuth } from '../auth/AuthProvider'
import { TrackArt, useTrackPlayer } from './create/pickers'
import { ORG_KIND_LABEL, discoverEvents, discoverOrgs, setSaved, type DiscoverEvent, type OrgCard } from '../lib/discover'
import { musicCatalog, setTrackSaved, type Track } from '../lib/social'
import { fmtMs, type StudioSong } from '../lib/studio'
import { usePlace } from '../lib/location'
import { useAsync } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { StudioSheet } from '../components/studio/Overlays'
import { FollowButton } from '../components/discover/FollowButton'
import { Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../ui'

type Tab = 'foryou' | 'trending' | 'saved'
type WithArt = OrgCard & { cover_path?: string | null; location?: string | null }

/** Open an artist on the big streaming services by name (a search, so it never points at the wrong page). */
const STREAMING = [
  { key: 'apple', label: 'Open artist in Apple Music', color: '#fa2d48', url: (q: string) => `https://music.apple.com/search?term=${encodeURIComponent(q)}` },
  { key: 'spotify', label: 'Open artist in Spotify', color: '#1ed760', url: (q: string) => `https://open.spotify.com/search/${encodeURIComponent(q)}` },
  { key: 'ytm', label: 'Open artist in YouTube Music', color: '#ff0033', url: (q: string) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}` },
  { key: 'yt', label: 'Open artist in YouTube', color: '#ff0000', url: (q: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
]
const share = async (title: string, path: string) => {
  const url = `${location.origin}${path}`
  try { if (navigator.share) { await navigator.share({ title, url }); return } await navigator.clipboard.writeText(url); toast('Link copied') } catch { /* cancelled */ }
}

/**
 * Discover music: artists to follow, concerts coming up and songs from the VYBE library. Big, confident type (names set
 * like posters), every card has a ⋮ menu with what you can do next. Songs go straight into a memory, a reel or a post.
 * No catalogue is scraped: songs are added by VYBE admins who hold the rights; streaming links are name searches.
 */
export default function Music() {
  const { uid, profile } = useAuth()
  const [here] = usePlace(profile)
  const [tab, setTab] = useState<Tab>('foryou')
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [playing, toggle] = useTrackPlayer()
  const [artistMenu, setArtistMenu] = useState<WithArt | null>(null)
  const [concertMenu, setConcertMenu] = useState<DiscoverEvent | null>(null)
  const [songMenu, setSongMenu] = useState<Track | null>(null)
  const nav = useNavigate(), device = useRef<HTMLInputElement>(null)
  const pickDevice = (f?: File) => {
    if (!f) return; const bad = validateSong(f); if (bad) return toast(bad)
    setSongMenu({ id: `device:${f.name}`, title: titleFromFile(f.name), artist: 'From my device', artwork_path: null, preview_path: null, external_url: null, saved: false, file: f } as Track & { file: File })
  }
  useEffect(() => { document.title = 'Music · VYBE' }, [])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const artists = useAsync(async () => {
    const rows = await discoverOrgs({ kinds: ['artist', 'creator'], q: dq, limit: 12 })
    if (!rows?.length) return rows as WithArt[] | null
    const { data } = await supabase.from('organizations').select('id,cover_path,location').in('id', rows.map(r => r.id))
    const extra = new Map(((data ?? []) as { id: string; cover_path: string | null; location: string | null }[]).map(x => [x.id, x]))
    return rows.map(r => ({ ...r, ...(extra.get(r.id) ?? {}) })) as WithArt[]
  }, [dq])
  const concerts = useAsync(() => discoverEvents({ group: 'concerts', q: dq, lat: here.lat, lng: here.lng, limit: 8 }).catch(() => null), [dq, here.lat, here.lng])
  const songs = useAsync(() => musicCatalog(tab, dq), [tab, dq])
  const [savedMap, setSavedMap] = useState<Record<string, boolean>>({})
  const isSaved = (t: Track) => savedMap[t.id] ?? t.saved
  const save = async (t: Track) => {
    const on = !isSaved(t); setSavedMap(m => ({ ...m, [t.id]: on }))
    try { await setTrackSaved(t.id, uid!, on); if (tab === 'saved') songs.reload() } catch (e) { setSavedMap(m => ({ ...m, [t.id]: !on })); toast(errMsg(e)) }
  }

  return (
    <div className="mu">
      <header className="mu-hero">
        <Link className="icon-btn" to="/app" aria-label="Back to Home"><ArrowLeft size={22} /></Link>
        <p className="mu-eyebrow">VYBE Music</p>
        <h1 className="mu-display">Discover<br />music</h1>
      </header>
      <input ref={device} type="file" hidden accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac" onChange={e => { pickDevice(e.target.files?.[0]); e.target.value = '' }} />
      <div className="mu-searchwrap">
        <label className="mu-search"><Search size={20} aria-hidden /><input type="search" aria-label="Search artists, concerts and songs" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} /></label>
        <div className="mu-chips" role="tablist" aria-label="Song lists">
          {([['foryou', 'For you'], ['trending', 'Trending'], ['saved', 'Saved']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`mu-chip${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
          <button className="mu-chip" onClick={() => device.current?.click()}><FolderOpen size={16} aria-hidden /> From device</button>
        </div>
      </div>

      <section className="mu-sec" aria-labelledby="mu-art">
        <div className="mu-sechead"><h2 id="mu-art">Artists</h2><Link to="/app/discover?mode=artists">See all</Link></div>
        {artists.loading && !artists.data ? <Spinner /> : artists.error ? <ErrorState message={artists.error} onRetry={artists.reload} /> : !artists.data?.length
          ? <p className="t-support mu-pad">{dq ? `No artists match “${dq}”.` : 'No artist pages yet. Artists create a page in the organisation portal and show up here.'}</p>
          : <ul className="mu-artists">{artists.data.map(o => <li key={o.id}><ArtistCard o={o} onMenu={() => setArtistMenu(o)} /></li>)}</ul>}
      </section>

      {concerts.data && concerts.data.length > 0 && (
        <section className="mu-sec" aria-labelledby="mu-con">
          <div className="mu-sechead"><h2 id="mu-con">Concerts</h2><Link to="/app/discover/c/music">See all</Link></div>
          <ul className="mu-concerts">{concerts.data.map(e => <li key={e.id}><ConcertRow e={e} onMenu={() => setConcertMenu(e)} /></li>)}</ul>
        </section>
      )}

      <section className="mu-sec" aria-labelledby="mu-songs">
        <div className="mu-sechead"><h2 id="mu-songs">{tab === 'trending' ? 'Trending songs' : tab === 'saved' ? 'Saved songs' : 'Songs for you'}</h2></div>
        {songs.loading && !songs.data ? <Spinner /> : songs.error ? <ErrorState message={songs.error} onRetry={songs.reload} /> : !songs.data?.length
          ? <Empty title={songs.data === null ? 'Music needs the latest update' : tab === 'saved' ? 'No saved songs' : dq ? 'No songs found' : 'The library is empty for now'}>{tab === 'saved' ? 'Tap the bookmark on a song to keep it here and in every music picker.' : 'Songs appear here when VYBE adds them. You can still use music from your device.'}</Empty>
          : <ul className="mu-songs">{songs.data.map((t, i) => (
            <li key={t.id} className="mu-song">
              <button className="mu-song-art" aria-label={playing === t.id ? `Pause ${t.title}` : `Play a preview of ${t.title}`} disabled={!t.preview_path} onClick={() => toggle(t)}>
                <TrackArt path={t.artwork_path} size={56} />
                {t.preview_path && <span className="ms-art-play" aria-hidden>{playing === t.id ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</span>}
              </button>
              <button className="mu-song-main" onClick={() => setSongMenu(t)} aria-label={`${t.title} by ${t.artist}: options`}>
                {tab === 'trending' && <span className="mu-rank" aria-hidden>{i + 1}</span>}
                <span className="mu-song-text"><span className="mu-song-title clamp-1">{t.title}{t.genre && <span className="ms-tag">{t.genre}</span>}</span><span className="mu-song-sub clamp-1">{t.artist}{t.duration_ms ? ` • ${fmtMs(t.duration_ms)}` : ''}</span></span>
              </button>
              <button className={`ms-save${isSaved(t) ? ' on' : ''}`} aria-pressed={isSaved(t)} aria-label={isSaved(t) ? `Remove ${t.title} from saved` : `Save ${t.title}`} onClick={() => void save(t)}><Bookmark size={26} fill={isSaved(t) ? 'currentColor' : 'none'} /></button>
            </li>))}</ul>}
      </section>

      {artistMenu && <ArtistSheet o={artistMenu} onClose={() => setArtistMenu(null)} />}
      {concertMenu && <ConcertSheet e={concertMenu} onClose={() => setConcertMenu(null)} />}
      {songMenu && <SongSheet t={songMenu} onClose={() => setSongMenu(null)} onUse={(where, s) => { setSongMenu(null); where === 'post' ? nav(s.track_id ? `/app/create?track=${s.track_id}` : '/app/create', { state: s.file ? { songFile: s.file } : undefined }) : nav(where === 'memory' ? '/app/memories/new' : '/app/reels/new', { state: { song: s } }) }} />}
    </div>
  )
}

function ArtistCard({ o, onMenu }: { o: WithArt; onMenu: () => void }) {
  const cover = useSigned(o.cover_path ?? null), logo = useSigned(o.avatar_path)
  const art = logo ?? cover
  return (
    <article className="mu-artist">
      <Link to={`/app/pages/${o.slug}`} className="mu-artist-link" aria-label={`${o.name}, ${ORG_KIND_LABEL[o.kind] ?? o.kind}`}>
        <span className="mu-artist-art" style={art ? { backgroundImage: `url(${art})` } : undefined} aria-hidden>{!art && o.name.charAt(0).toUpperCase()}</span>
        <span className="mu-artist-text">
          <span className="mu-kicker">{ORG_KIND_LABEL[o.kind] ?? o.kind}{o.verified && <BadgeCheck size={14} aria-label="Verified by VYBE" />}</span>
          <span className="mu-name clamp-2">{o.name}</span>
          <span className="mu-meta clamp-1">{[o.location, o.upcoming ? `${o.upcoming} upcoming` : null, `${o.followers} ${o.followers === 1 ? 'follower' : 'followers'}`].filter(Boolean).join(' • ')}</span>
        </span>
      </Link>
      <button className="mu-kebab" aria-label={`More for ${o.name}`} onClick={onMenu}><MoreVertical size={22} /></button>
    </article>
  )
}

function ConcertRow({ e, onMenu }: { e: DiscoverEvent; onMenu: () => void }) {
  const cover = useSigned(e.cover_path)
  const name = e.artists[0] ?? e.org?.name ?? e.title
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: e.timezone }).format(new Date(e.starts_at))
  return (
    <article className="mu-concert">
      <Link to={`/app/plans/${e.id}`} className="mu-concert-link" aria-label={`${name} at ${e.venue ?? e.city ?? 'venue to be announced'}, ${date}`}>
        <span className="mu-concert-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined} aria-hidden>{!cover && name.charAt(0).toUpperCase()}</span>
        <span className="mu-concert-text">
          <span className="mu-date"><CalendarDays size={15} aria-hidden /> {date}</span>
          <span className="mu-name clamp-1">{name}</span>
          <span className="mu-venue clamp-1">{e.format === 'online' ? 'Online' : e.venue || e.location || 'Venue to be announced'}</span>
          <span className="mu-meta clamp-1">{[e.city, e.distance_km != null ? `${e.distance_km < 1 ? '<1' : Math.round(e.distance_km)} km` : null].filter(Boolean).join(' • ')}</span>
        </span>
      </Link>
      <button className="mu-kebab" aria-label={`More for ${name}`} onClick={onMenu}><MoreVertical size={22} /></button>
    </article>
  )
}

function SheetHead({ art, title, sub, round }: { art?: string | null; title: string; sub: string; round?: boolean }) {
  return (
    <div className="mu-sh-head">
      <span className={`mu-sh-art${round ? ' round' : ''}`} style={art ? { backgroundImage: `url(${art})` } : undefined} aria-hidden>{!art && title.charAt(0).toUpperCase()}</span>
      <span><b className="clamp-1">{title}</b><span className="clamp-1">{sub}</span></span>
    </div>
  )
}
const Stream = ({ name }: { name: string }) => (
  <>{STREAMING.map(s => <a key={s.key} href={s.url(name)} target="_blank" rel="noopener noreferrer nofollow"><span className="mu-svc" style={{ background: s.color }} aria-hidden><Music2 size={16} /></span>{s.label}</a>)}</>
)

function ArtistSheet({ o, onClose }: { o: WithArt; onClose: () => void }) {
  const art = useSigned(o.avatar_path ?? o.cover_path ?? null)
  return (
    <StudioSheet title={o.name} onClose={onClose}>
      <SheetHead art={art} title={o.name.toUpperCase()} sub={[ORG_KIND_LABEL[o.kind] ?? o.kind, o.location].filter(Boolean).join(' • ')} round />
      <div className="ss-menu mu-menu">
        <div className="mu-follow"><FollowButton type="organization" id={o.id} following={o.following} label={o.name} size="md" /></div>
        <Link to={`/app/pages/${o.slug}`} onClick={onClose}><Info size={22} aria-hidden /> View artist</Link>
        <Link to={`/app/search?q=${encodeURIComponent(o.name)}`} onClick={onClose}><CalendarDays size={22} aria-hidden /> View all concerts</Link>
        <Stream name={o.name} />
        <button onClick={() => void share(o.name, `/app/pages/${o.slug}`)}><Share2 size={22} aria-hidden /> Share</button>
      </div>
    </StudioSheet>
  )
}

function ConcertSheet({ e, onClose }: { e: DiscoverEvent; onClose: () => void }) {
  const { uid } = useAuth()
  const art = useSigned(e.cover_path)
  const name = e.artists[0] ?? e.org?.name ?? e.title
  const [saved, setS] = useState(false)
  const saveIt = async () => { try { await setSaved(e.id, uid!, !saved); setS(!saved); toast(saved ? 'Removed from saved' : 'Concert saved') } catch (err) { toast(errMsg(err)) } }
  return (
    <StudioSheet title={name} onClose={onClose}>
      <SheetHead art={art} title={name.toUpperCase()} sub={[e.venue, e.city].filter(Boolean).join(', ') || 'Venue to be announced'} />
      <div className="ss-menu mu-menu">
        <Link to={`/app/plans/${e.id}`} onClick={onClose}><CalendarDays size={22} aria-hidden /> View concert</Link>
        <Link to={`/app/search?q=${encodeURIComponent(name)}`} onClick={onClose}><CalendarDays size={22} aria-hidden /> View all concerts</Link>
        {e.org && <Link to={`/app/pages/${e.org.slug}`} onClick={onClose}><Info size={22} aria-hidden /> View artist</Link>}
        <Stream name={name} />
        <button onClick={() => void share(`${name} · ${e.title}`, `/app/plans/${e.id}`)}><Share2 size={22} aria-hidden /> Share</button>
        <button onClick={() => void saveIt()}><Plus size={22} aria-hidden /> {saved ? 'Saved' : 'Save concert'}</button>
      </div>
    </StudioSheet>
  )
}

function SongSheet({ t, onClose, onUse }: { t: Track & { file?: File }; onClose: () => void; onUse: (where: 'memory' | 'reel' | 'post', s: StudioSong) => void }) {
  const s: StudioSong = { track_id: t.file ? undefined : t.id, title: t.title, artist: t.artist, preview_path: t.preview_path, artwork_path: t.artwork_path, duration_ms: t.duration_ms ?? null, file: t.file, start_ms: 0 }
  return (
    <StudioSheet title={t.title} onClose={onClose}>
      <div className="mu-sh-head"><TrackArt path={t.artwork_path} size={64} /><span><b className="clamp-1">{t.title}</b><span className="clamp-1">{t.artist}{t.duration_ms ? ` • ${fmtMs(t.duration_ms)}` : ''}</span></span></div>
      <div className="ss-menu mu-menu">
        <button onClick={() => onUse('memory', s)}><Sparkles size={22} aria-hidden /> Add to a memory</button>
        <button onClick={() => onUse('reel', s)}><Clapperboard size={22} aria-hidden /> Make a reel with this song</button>
        <button onClick={() => onUse('post', s)}><SquarePen size={22} aria-hidden /> Share in a post</button>
        {t.external_url && <a href={t.external_url} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={22} aria-hidden /> Listen to the full song</a>}
        {!t.file && <Stream name={`${t.artist} ${t.title}`} />}
      </div>
    </StudioSheet>
  )
}
