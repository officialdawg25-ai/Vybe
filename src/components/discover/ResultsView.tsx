import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Map as MapIcon, SlidersHorizontal, UsersRound } from 'lucide-react'
import { discoverEvents, rangeBounds, useCategories, type DiscoverEvent } from '../../lib/discover'
import { useAsync } from '../../lib/hooks'
import { Empty, ErrorState, Sheet, Spinner } from '../../ui'
import { EventPoster } from './EventPoster'
import { DiscoverMap } from './DiscoverMap'

type Range = 'any' | 'today' | 'weekend' | 'week' | 'month'
const RANGES: { id: Range; label: string }[] = [{ id: 'any', label: 'Any time' }, { id: 'today', label: 'Today' }, { id: 'weekend', label: 'This weekend' }, { id: 'week', label: 'Next 7 days' }, { id: 'month', label: 'This month' }]
const bounds = (r: Range) => r === 'month' ? { from: new Date().toISOString(), to: new Date(Date.now() + 31 * 864e5).toISOString() } : rangeBounds(r)
const PAGE = 20

export interface Scope { lat?: number; lng?: number; radiusKm?: number; label: string }

/** Where a Discover category or filter starts the results (the member can still change any of it). */
export interface Preset { categories?: string[]; format?: 'in_person' | 'online'; followed?: boolean; sort?: 'soonest' | 'nearest' }

/** A category's plans: server-side filtered and paginated. "When" sits on the page; everything else is in one Filters sheet so the
 *  screen stays clean; Map opens the full-screen map of the results. Filters live in the component so they survive browsing. */
export function ResultsView({ group, q, scope, preset = {}, title }: { group: 'concerts' | 'events'; q: string; scope: Scope; preset?: Preset; title?: string }) {
  const cats = useCategories()
  const pool = useMemo(() => cats.filter(c => (group === 'concerts' ? c.group_key === 'concerts' : true)), [cats, group])
  const [range, setRange] = useState<Range>('any')
  const [picked, setPicked] = useState<string[]>(preset.categories ?? [])
  const [price, setPrice] = useState<'any' | 'free' | 'paid'>('any')
  const [fmt, setFmt] = useState<'any' | 'in_person' | 'online'>(preset.format ?? 'any')
  const [followed, setFollowed] = useState(Boolean(preset.followed))
  const [friends, setFriends] = useState(false)
  const [sort, setSort] = useState<'soonest' | 'nearest'>(preset.sort ?? 'soonest')
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
  // What the screen itself stands for (its category, Online, Following) is not a filter the member added: it is not
  // counted, and clearing or resetting returns to it rather than removing it.
  const base = { cats: preset.categories ?? [], fmt: (preset.format ?? 'any') as 'any' | 'in_person' | 'online', followed: Boolean(preset.followed) }
  const extraCats = picked.filter(c => !base.cats.includes(c)).length + base.cats.filter(c => !picked.includes(c)).length
  const anyFilter = range !== 'any' || extraCats > 0 || price !== 'any' || fmt !== base.fmt || followed !== base.followed || friends
  const clear = () => { setRange('any'); setPicked(base.cats); setPrice('any'); setFmt(base.fmt); setFollowed(base.followed); setFriends(false) }

  const count = extraCats + (price !== 'any' ? 1 : 0) + (fmt !== base.fmt ? 1 : 0) + (followed !== base.followed ? 1 : 0) + (friends ? 1 : 0) + (sort !== (preset.sort ?? 'soonest') ? 1 : 0)
  const [sheet, setSheet] = useState(false)
  const [map, setMap] = useState(false)

  return (
    <div className="rv">
      <div className="rv-bar">
        <div className="rv-when" role="group" aria-label="When">{RANGES.map(r => <button key={r.id} className="chip" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>)}</div>
        <div className="rv-tools">
          <button className="rv-tool" aria-haspopup="dialog" onClick={() => setSheet(true)}><SlidersHorizontal size={16} aria-hidden /> Filters{count ? <span className="rv-badge" aria-label={`${count} on`}>{count}</span> : null}</button>
          <button className="rv-tool" aria-haspopup="dialog" disabled={!rows.length} onClick={() => setMap(true)}><MapIcon size={16} aria-hidden /> Map</button>
          {rows.length > 0 && <span className="rv-count t-meta" aria-live="polite">{rows.length}{more ? '+' : ''} {rows.length === 1 ? 'plan' : 'plans'}</span>}
        </div>
      </div>

      {first.loading && !first.data ? <Spinner /> : first.error ? <ErrorState message={first.error} onRetry={first.reload} /> : first.data === null ? (
        <p className="notice" role="status">Discover is being upgraded on this server. Browse plans on the Plans page for now.</p>
      ) : !rows.length ? (
        <Empty title={`No ${group === 'concerts' ? 'shows' : 'plans'} ${anyFilter ? 'match these filters' : 'yet'}`} action={<div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {anyFilter && <button className="btn" onClick={clear}>Clear filters</button>}
          <Link className="btn primary" to="/app/plans?new=1">Host one</Link></div>}>
          {scope.lat != null ? `Nothing within ${scope.radiusKm ?? 100} km of ${scope.label}. Try All locations, another town or another date.` : 'Try another date, or follow artists and organisers to hear when they publish.'}
        </Empty>
      ) : (
        <>
          <div className="poster-grid">{rows.map(e => <EventPoster key={e.id} e={e} />)}</div>
          {more && <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}><button className="btn" disabled={loadingMore} onClick={showMore}>{loadingMore ? 'Loading…' : 'Show more'}</button></div>}
        </>
      )}

      {sheet && (
        <Sheet title="Filters" onClose={() => setSheet(false)}>
          <div className="rv-sheet">
            {pool.length > 1 && !base.cats.length && <fieldset><legend>Category</legend><div className="chips">{pool.map(c => <button key={c.slug} className="chip" aria-pressed={picked.includes(c.slug)} onClick={() => toggleCat(c.slug)}>{c.label}</button>)}</div></fieldset>}
            <fieldset><legend>Price</legend><div className="chips">{(['any', 'free', 'paid'] as const).map(p => <button key={p} className="chip" aria-pressed={price === p} onClick={() => setPrice(p)}>{{ any: 'Any price', free: 'Free', paid: 'Paid' }[p]}</button>)}</div></fieldset>
            <fieldset><legend>Where it happens</legend><div className="chips">{(['any', 'in_person', 'online'] as const).map(f => <button key={f} className="chip" aria-pressed={fmt === f} onClick={() => setFmt(f)}>{{ any: 'Anywhere', in_person: 'In person', online: 'Online' }[f]}</button>)}</div></fieldset>
            <fieldset><legend>People</legend><div className="chips">
              <button className="chip" aria-pressed={followed} onClick={() => setFollowed(v => !v)}>From people I follow</button>
              <button className="chip" aria-pressed={friends} onClick={() => setFriends(v => !v)}><UsersRound size={14} aria-hidden /> Friends going</button>
            </div></fieldset>
            <fieldset><legend>Order</legend><div className="chips">
              <button className="chip" aria-pressed={sort === 'soonest'} onClick={() => setSort('soonest')}>Soonest first</button>
              <button className="chip" aria-pressed={sort === 'nearest'} disabled={scope.lat == null} onClick={() => setSort('nearest')}>Nearest first{scope.lat == null ? ' (pick a place)' : ''}</button>
            </div></fieldset>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <button className="btn ghost" disabled={!anyFilter && sort === (preset.sort ?? 'soonest')} onClick={() => { clear(); setSort(preset.sort ?? 'soonest') }}>Reset</button>
            <button className="btn primary" onClick={() => setSheet(false)}>Show {rows.length}{more ? '+' : ''} {rows.length === 1 ? 'plan' : 'plans'}</button>
          </div>
        </Sheet>
      )}
      {map && <DiscoverMap rows={rows} title={title ?? (group === 'concerts' ? 'Concerts & music' : 'Plans')} onClose={() => setMap(false)} />}
    </div>
  )
}
