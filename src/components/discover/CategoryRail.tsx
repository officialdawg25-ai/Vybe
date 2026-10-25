import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { useSigned } from '../../ui'
import type { TileMedia } from '../../lib/tiles'

export interface Tile { id: string; label: string; icon: LucideIcon; accent: string; art?: string | null; media?: TileMedia | null }

const SPEED = 28          // pixels per second: slow enough to read every tile as it passes
const RESUME_MS = 3500    // after a swipe, tap or hover the rail waits this long before gliding again

/**
 * The way into Discover's categories: a row of tall tiles that glides slowly to the left on its own, showing every
 * category in turn, and loops. Touching, hovering or focusing it stops the motion so it can be swiped or tabbed freely;
 * it picks up again a few seconds later. People who ask for reduced motion get a still row they swipe themselves.
 * Each tile is a link to that category's own screen. The second copy that makes the loop seamless is hidden from
 * assistive technology and the keyboard.
 */
export function CategoryRail({ tiles, label = 'Explore categories' }: { tiles: Tile[]; label?: string }) {
  const list = useRef<HTMLDivElement>(null)
  const held = useRef(0)              // timestamp until which the auto-glide waits
  const [calm] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [edge, setEdge] = useState({ start: true, end: false })
  const loop = !calm && tiles.length > 2

  useEffect(() => {
    const el = list.current
    if (!el || !loop) return
    let raf = 0, last = performance.now(), carry = 0
    const tick = (now: number) => {
      const dt = Math.min(64, now - last); last = now
      const half = el.scrollWidth / 2
      if (now > held.current && !document.hidden && half > el.clientWidth) {
        carry += (SPEED * dt) / 1000
        const step = Math.floor(carry)
        if (step) { carry -= step; el.scrollLeft += step }
      }
      if (el.scrollLeft >= half) el.scrollLeft -= half          // the copy lines up exactly with the original: no jump
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [loop, tiles.length])

  const hold = () => { held.current = performance.now() + RESUME_MS }
  const measure = () => {
    const el = list.current; if (!el || loop) return
    const start = el.scrollLeft <= 4, end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4
    setEdge(e => (e.start === start && e.end === end ? e : { start, end }))
  }
  const page = (dir: 1 | -1) => { hold(); const el = list.current; if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: calm ? 'auto' : 'smooth' }) }
  useEffect(() => { measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) })

  return (
    <nav className={`crail${loop ? ' gliding' : ''}`} aria-label={label}>
      {(loop || !edge.start) && <button type="button" className="crail-arrow prev" aria-label="Previous categories" onClick={() => page(-1)}><ChevronLeft size={20} /></button>}
      <div ref={list} className="crail-list" onScroll={measure} onPointerDown={hold} onPointerMove={e => { if (e.pointerType === 'mouse') hold() }} onWheel={hold} onTouchMove={hold} onFocus={() => { held.current = Infinity }} onBlur={hold}>
        {tiles.map(t => <TileLink key={t.id} t={t} />)}
        {loop && tiles.map(t => <TileLink key={`copy-${t.id}`} t={t} copy />)}
      </div>
      {(loop || !edge.end) && <button type="button" className="crail-arrow next" aria-label="More categories" onClick={() => page(1)}><ChevronRight size={20} /></button>}
    </nav>
  )
}

function TileLink({ t, copy = false }: { t: Tile; copy?: boolean }) {
  const eventArt = useSigned(t.media ? null : t.art ?? null)
  const image = t.media && !t.media.video ? t.media.url : eventArt
  const Icon = t.icon
  return (
    <Link to={`/app/discover/c/${t.id}`} className={`crail-tile${image || t.media ? ' has-art' : ''}`} aria-hidden={copy || undefined} tabIndex={copy ? -1 : undefined}
      style={{ ['--tile' as string]: t.accent, ...(image ? { backgroundImage: `url(${image})` } : {}) }}>
      {t.media?.video && <video className="crail-video" src={t.media.url} muted loop autoPlay playsInline preload="metadata" aria-hidden />}
      <span className="crail-ico" aria-hidden><Icon size={22} aria-hidden /></span>
      <span className="crail-label">{t.label}</span>
    </Link>
  )
}
