import { useEffect, useMemo, useState } from 'react'
import { Collapse } from '../Collapse'
import { Link } from 'react-router-dom'
import { List, Map as MapIcon, UsersRound } from 'lucide-react'
import { discoverEvents, rangeBounds, useCategories, type DiscoverEvent } from '../../lib/discover'
import { staticMap, useMapsConfigured } from '../../lib/maps'
import { useAsync } from '../../lib/hooks'
import { Empty, ErrorState, Spinner } from '../../ui'
import { EventPoster } from './EventPoster'

type Range = 'any' | 'today' | 'weekend' | 'week' | 'month'
const RANGES: { id: Range; label: string }[] = [{ id: 'any', label: 'Any time' }, { id: 'today', label: 'Today' }, { id: 'weekend', label: 'This weekend' }, { id: 'week', label: 'Next 7 days' }, { id: 'month', label: 'This month' }]
const bounds = (r: Range) => r === 'month' ? { from: new Date().toISOString(), to: new Date(Date.now() + 31 * 864e5).toISOString() } : rangeBounds(r)
const PAGE = 20

export interface Scope { lat?: number; lng?: number; radiusKm?: number; label: string }

/** Where a Discover category or filter starts the results (the member can still change any of it). */
export interface Preset { categories?: string[]; format?: 'in_person' | 'online'; followed?: boolean; sort?: 'soonest' | 'nearest' }

/** Concerts & shows / Events: server-side filtered, paginated, list or map. Filters live in the component so the page keeps them while you browse. */
export function ResultsView({ group, q, scope, preset = {} }: { group: 'concerts' | 'events'; q: string; scope: Scope; preset?: Preset }) {
  const cats = useCategories()
  const pool = useMemo(() => cats.filter(c => (group === 'concerts' ? c.group_key === 'concerts' : true)), [cats, group])
  const [range, setRange] = useState<Range>('any')
  const [picked, setPicked] = useState<string[]>(preset.categories ?? [])
  const [price, setPrice] = useState<'any' | 'free' | 'paid'>('any')
  const [fmt, setFmt] = useState<'any' | 'in_person' | 'online'>(preset.format ?? 'any')
  const [followed, setFollowed] = useState(Boolean(preset.followed))
  const [friends, setFriends] = useState(false)
  const [sort, setSort] = useState<'soonest' | 'nearest'>(preset.sort ?? 'soonest')
  const [view, setView] = useState<'list' | 'map'>('list')
  const [extra, setExtra] = useState<DiscoverEvent[]>([])
  const [more, setMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const key = JSON.stringify([group, q, scope, range, picked, price, fmt, followed, friends, sort])
  const args = () => ({ q, group: group === 'concerts' ? ('concerts' as const) : undefined, categories: picked, format: fmt === 'any' ? undefined : fmt, free: price === 'any' ? null : price === 'free',
    ...bounds(range), lat: scope.lat, lng: scope.lng, radiusKm: scope.radiusKm, followed, friends, sort: sort === 'nearest' && scope.lat == null ? ('soonest' as const) : sort })
  const first = useAsync(async () => { setExtra([]); setMore(true); const r = await discoverEvents({ ...args(), limit: PAGE }); setMore((r?.length ?? 0) === PAGE); return r }, [key])
  const rows = [...(first.data ?? []), ...extra]
  const showMore = async () => {
    setLoadingMore(true)
    try { const r = (await discoverEvents({ ...args(), limit: PAGE, offset: rows.length })) ?? []; setExtra(x => [...x, ...r]); setMore(r.length === PAGE) } finally { setLoadingMore(false) }
  }
  const toggleCat = (s: string) => setPicked(p => (p.includes(s) ? p.filter(x => x !== s) : [...p, s]))
  const anyFilter = range !== 'any' || picked.length > 0 || price !== 'any' || fmt !== 'any' || followed || friends
  const clear = () => { setRange('any'); setPicked([]); setPrice('any'); setFmt('any'); setFollowed(false); setFriends(false) }

  return (
    <div>
      <div className="d-filters" aria-label="Filters">
        <Collapse title="Filters" summary={anyFilter ? 'On' : 'Any'} defaultOpen={anyFilter}>
        <div className="chips" role="group" aria-label="When">{RANGES.map(r => <button key={r.id} className="chip" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>)}</div>
        {pool.length > 0 && <div className="chips" role="group" aria-label="Category">{pool.map(c => <button key={c.slug} className="chip" aria-pressed={picked.includes(c.slug)} onClick={() => toggleCat(c.slug)}>{c.label}</button>)}</div>}
        <div className="chips" role="group" aria-label="More filters">
          {(['any', 'free', 'paid'] as const).map(p => <button key={p} className="chip" aria-pressed={price === p} onClick={() => setPrice(p)}>{{ any: 'Any price', free: 'Free', paid: 'Paid' }[p]}</button>)}
          {(['any', 'in_person', 'online'] as const).map(f => <button key={f} className="chip" aria-pressed={fmt === f} onClick={() => setFmt(f)}>{{ any: 'In person or online', in_person: 'In person', online: 'Online' }[f]}</button>)}
          <button className="chip" aria-pressed={followed} onClick={() => setFollowed(v => !v)}>From people I follow</button>
          <button className="chip" aria-pressed={friends} onClick={() => setFriends(v => !v)}><UsersRound size={14} aria-hidden /> Friends going</button>
        </div>
        </Collapse>
        <div className="row between">
          <label className="t-meta row" style={{ gap: 6 }}>Sort<select className="select" style={{ width: 'auto', minHeight: 36 }} value={sort} onChange={e => setSort(e.target.value as 'soonest' | 'nearest')}><option value="soonest">Soonest</option><option value="nearest" disabled={scope.lat == null}>Nearest{scope.lat == null ? ' (pick a place)' : ''}</option></select></label>
          <div className="seg" role="group" aria-label="View">
            <button className="chip" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} aria-hidden /> List</button>
            <button className="chip" aria-pressed={view === 'map'} onClick={() => setView('map')}><MapIcon size={14} aria-hidden /> Map</button>
          </div>
        </div>
      </div>

      {first.loading && !first.data ? <Spinner /> : first.error ? <ErrorState message={first.error} onRetry={first.reload} /> : first.data === null ? (
        <p className="notice" role="status">Discover is being upgraded on this server. Browse plans on the Plans page for now.</p>
      ) : !rows.length ? (
        <Empty title={`No ${group === 'concerts' ? 'shows' : 'events'} match`} action={<div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {anyFilter && <button className="btn" onClick={clear}>Clear filters</button>}
          <Link className="btn primary" to="/app/plans?new=1">Host one</Link></div>}>
          {scope.lat != null ? `Nothing within ${scope.radiusKm ?? 100} km of ${scope.label}. Try All locations, another town or a wider date range.` : 'Try another date range or category, or follow artists and organisers to hear when they publish.'}
        </Empty>
      ) : (
        <>
          {view === 'map' && <MapPane rows={rows} />}
          <div className="poster-grid">{rows.map((e, i) => <EventPoster key={e.id} e={e} index={view === 'map' && i < 10 ? i : undefined} />)}</div>
          {more && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}><button className="btn" disabled={loadingMore} onClick={showMore}>{loadingMore ? 'Loading…' : 'Show more'}</button></div>}
        </>
      )}
    </div>
  )
}

/** Static map of the first ten results with lettered markers matching the tiles. No key / no function => plain explanation, list still works. */
function MapPane({ rows }: { rows: DiscoverEvent[] }) {
  const configured = useMapsConfigured()
  const pts = rows.filter(r => r.lat != null && r.lng != null).slice(0, 10)
  const sig = pts.map(p => `${p.lat},${p.lng}`).join('|')
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!configured || !pts.length) return
    let live = true, url: string | null = null
    setFailed(false)
    staticMap(pts.map(p => ({ lat: p.lat!, lng: p.lng! })), { dark: document.documentElement.dataset.theme === 'dark' }).then(u => { url = u; if (live) { setSrc(u); setFailed(!u) } else if (u) URL.revokeObjectURL(u) })
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, sig])
  if (configured === null) return <div className="skeleton" style={{ height: 200, borderRadius: 16, marginBottom: 16 }} aria-hidden />
  if (!pts.length) return <p className="notice" role="status" style={{ marginBottom: 16 }}>None of these results have a map location (online or location not set).</p>
  if (!configured || failed) return <p className="notice" role="status" style={{ marginBottom: 16 }}>The map isn’t available right now. Addresses are shown on each plan, and you can still open directions from there.</p>
  return src ? <img className="map-img" src={src} alt={`Map of ${pts.length} events, labelled A to ${String.fromCharCode(64 + pts.length)}`} /> : <div className="skeleton" style={{ height: 200, borderRadius: 16, marginBottom: 16 }} aria-hidden />
}
