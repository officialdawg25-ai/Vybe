import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, MapPin, Navigation, X } from 'lucide-react'
import { loadGoogleMaps, mapsBrowserKey, type GMap, type GMarker, type GMaps } from '../../lib/maps'
import { directionsUrl } from '../../lib/cities'
import { shortDate, type DiscoverEvent } from '../../lib/discover'
import { useSigned } from '../../ui'

type Pt = DiscoverEvent & { lat: number; lng: number }

/**
 * Full-screen map of the results, in VYBE's own look: dark brand map, purple pins, and a row of cards along the bottom.
 * Choosing a pin brings its card forward; swiping the cards moves the map. With a Google browser key (served by the maps
 * function) it is a real Google map; without one it is VYBE's own plan of the area: the same pins at their true relative
 * positions on a branded canvas, with a note that the street map arrives once Google Maps is switched on.
 */
export function DiscoverMap({ rows, title, onClose }: { rows: DiscoverEvent[]; title: string; onClose: () => void }) {
  const pts = useMemo(() => rows.filter((r): r is Pt => r.lat != null && r.lng != null), [rows])
  const [sel, setSel] = useState(0)
  const [key, setKey] = useState<string | null | undefined>(undefined)       // undefined = still asking
  const cards = useRef<HTMLUListElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const fromCards = useRef(false)

  useEffect(() => { let live = true; mapsBrowserKey().then(k => live && setKey(k)); return () => { live = false } }, [])
  useEffect(() => {
    closeBtn.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.documentElement.classList.add('map-open')
    return () => { document.removeEventListener('keydown', onKey); document.documentElement.classList.remove('map-open') }
  }, [onClose])

  // Pin -> card: scroll the chosen card into the middle of the row.
  const pick = (i: number) => {
    setSel(i)
    const li = cards.current?.children[i] as HTMLElement | undefined
    if (li && cards.current) { fromCards.current = false; cards.current.scrollTo({ left: li.offsetLeft - (cards.current.clientWidth - li.offsetWidth) / 2, behavior: 'smooth' }) }
  }
  // Card -> pin: whichever card sits in the middle after a swipe becomes the selection.
  const onCardsScroll = () => {
    const el = cards.current; if (!el) return
    const mid = el.scrollLeft + el.clientWidth / 2
    let best = 0, dist = Infinity
    ;[...el.children].forEach((c, i) => { const h = c as HTMLElement, d = Math.abs(h.offsetLeft + h.offsetWidth / 2 - mid); if (d < dist) { dist = d; best = i } })
    if (best !== sel) { fromCards.current = true; setSel(best) }
  }

  const missing = rows.length - pts.length
  return (
    <div className="dmap" role="dialog" aria-modal="true" aria-label={`Map: ${title}`}>
      <header className="dmap-top">
        <button ref={closeBtn} className="icon-btn" aria-label="Close the map" onClick={onClose}><X size={22} /></button>
        <div className="grow"><h2 className="dmap-title clamp-1">{title}</h2><p className="dmap-sub">{pts.length} on the map{missing ? ` · ${missing} online or without a location` : ''}</p></div>
      </header>
      <div className="dmap-canvas">
        {pts.length === 0 ? <p className="dmap-empty">None of these plans has a map location yet (online, or the address hasn’t been set).</p>
          : key === undefined ? <div className="dmap-loading" aria-hidden />
          : key ? <GoogleCanvas apiKey={key} pts={pts} sel={sel} onPick={pick} fallback={<BrandCanvas pts={pts} sel={sel} onPick={pick} note="Google Maps could not load, so this is VYBE’s plan of the area." />} />
          : <BrandCanvas pts={pts} sel={sel} onPick={pick} note="VYBE’s plan of the area: pins are in their true positions. The street map appears once Google Maps is switched on." />}
      </div>
      {pts.length > 0 && (
        <ul ref={cards} className="dmap-cards" onScroll={onCardsScroll} aria-label="Plans on the map">
          {pts.map((p, i) => <li key={p.id}><MapCard p={p} letter={letter(i)} on={i === sel} onFocus={() => pick(i)} /></li>)}
        </ul>
      )}
    </div>
  )
}

const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1))

function MapCard({ p, letter: l, on, onFocus }: { p: Pt; letter: string; on: boolean; onFocus: () => void }) {
  const cover = useSigned(p.cover_path)
  const where = [p.venue, p.city].filter(Boolean).join(', ') || p.location || 'Location on the plan'
  return (
    <article className={`dmap-card${on ? ' on' : ''}`} onFocus={onFocus}>
      <Link to={`/app/plans/${p.id}`} className="dmap-card-main">
        <span className="dmap-card-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>{!cover && p.title.charAt(0).toUpperCase()}<span className="dmap-pin-tag" aria-hidden>{l}</span></span>
        <span className="dmap-card-copy">
          <b className="clamp-2">{p.title}</b>
          <span className="t-meta clamp-1"><Calendar size={12} aria-hidden /> {shortDate(p.starts_at, p.timezone)}</span>
          <span className="t-meta clamp-1"><MapPin size={12} aria-hidden /> {where}{p.distance_km != null ? ` · ${p.distance_km < 1 ? '<1' : Math.round(p.distance_km)} km` : ''}</span>
          {p.going > 0 && <span className="t-meta">{p.going} going</span>}
        </span>
      </Link>
      <a className="dmap-go" href={directionsUrl({ lat: p.lat, lng: p.lng }, 'google') ?? '#'} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${p.title}`}><Navigation size={18} aria-hidden /></a>
    </article>
  )
}

/* ------------------------------------------------------------- Google map */
// VYBE's night palette for Google's map: deep violet land, quiet roads, brand-purple water and parks.
const STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#14112b' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#a59fc9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0d0b1d' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2a2450' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#1b2a2a' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#262046' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a2f78' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0820' }] },
]
const pinSvg = (l: string, on: boolean) => {
  const s = on ? 46 : 36
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s * 1.25}" viewBox="0 0 40 50"><path d="M20 49C20 49 4 31 4 19a16 16 0 1 1 32 0c0 12-16 30-16 30z" fill="${on ? '#ffffff' : '#7c5cff'}" stroke="${on ? '#7c5cff' : '#ffffff'}" stroke-width="2.5"/><text x="20" y="25" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="15" font-weight="800" fill="${on ? '#4a2fd0' : '#ffffff'}">${l}</text></svg>`)}`
}

function GoogleCanvas({ apiKey, pts, sel, onPick, fallback }: { apiKey: string; pts: Pt[]; sel: number; onPick: (i: number) => void; fallback: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<{ g: GMaps; m: GMap; markers: GMarker[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const pickRef = useRef(onPick); pickRef.current = onPick
  useEffect(() => {
    let live = true
    loadGoogleMaps(apiKey).then(g => {
      if (!live || !el.current) return
      const m = new g.Map(el.current, { center: { lat: pts[0].lat, lng: pts[0].lng }, zoom: 12, styles: STYLE, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', backgroundColor: '#14112b', clickableIcons: false })
      const bounds = new g.LatLngBounds()
      const markers = pts.map((p, i) => {
        bounds.extend({ lat: p.lat, lng: p.lng })
        const mk = new g.Marker({ map: m, position: { lat: p.lat, lng: p.lng }, title: p.title, icon: { url: pinSvg(letter(i), false), scaledSize: new g.Size(36, 45), anchor: new g.Point(18, 45) }, optimized: false })
        mk.addListener('click', () => pickRef.current(i))
        return mk
      })
      if (pts.length > 1) m.fitBounds(bounds, 64); else m.setZoom(14)
      map.current = { g, m, markers }
    }).catch(() => live && setFailed(true))
    return () => { live = false; map.current?.markers.forEach(mk => mk.setMap(null)); map.current = null }
  }, [apiKey, pts])
  useEffect(() => {
    const cur = map.current; if (!cur) return
    cur.markers.forEach((mk, i) => { const on = i === sel; mk.setIcon({ url: pinSvg(letter(i), on), scaledSize: new cur.g.Size(on ? 46 : 36, on ? 57 : 45), anchor: new cur.g.Point(on ? 23 : 18, on ? 57 : 45) }); mk.setZIndex(on ? 999 : i) })
    const p = pts[sel]; if (p) cur.m.panTo({ lat: p.lat, lng: p.lng })
  }, [sel, pts])
  if (failed) return <>{fallback}</>
  return <div ref={el} className="dmap-google" role="application" aria-label="Map of the plans" />
}

/* ------------------------------------------------------------- VYBE plan (no key) */
function BrandCanvas({ pts, sel, onPick, note }: { pts: Pt[]; sel: number; onPick: (i: number) => void; note: string }) {
  // Equirectangular projection around the middle of the points: honest relative positions at city scale.
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length
  const k = Math.cos((lat0 * Math.PI) / 180)
  const xs = pts.map(p => p.lng * k), ys = pts.map(p => -p.lat)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const span = Math.max(maxX - minX, maxY - minY, 0.01)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  // Pins stay inside the clear middle of the screen: below the title and note, above the row of cards.
  const pos = (i: number) => ({ left: `${50 + ((xs[i] - cx) / span) * 72}%`, top: `${48 + ((ys[i] - cy) / span) * 40}%` })
  const km = Math.max(1, Math.round((span / k) * 111))
  return (
    <div className="dmap-brand" aria-label="Plan of the area">
      <div className="dmap-rings" aria-hidden />
      {pts.map((p, i) => (
        <button key={p.id} type="button" className={`dmap-pin${i === sel ? ' on' : ''}`} style={pos(i)} aria-label={`${letter(i)}: ${p.title}`} aria-pressed={i === sel} onClick={() => onPick(i)}><span><i>{letter(i)}</i></span></button>
      ))}
      <p className="dmap-note"><span className="dmap-scale" aria-hidden />About {km} km across · {note}</p>
    </div>
  )
}
