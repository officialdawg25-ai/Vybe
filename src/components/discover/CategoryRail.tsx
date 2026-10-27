import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { useSigned } from '../../ui'
import { preload, useReadyImage } from '../../lib/imgCache'
import type { TileMedia } from '../../lib/tiles'

export interface Tile { id: string; label: string; icon: LucideIcon; accent: string; art?: string | null; media?: TileMedia | null }

const SPEED = 30          // pixels per second: slow enough to read every tile as it passes
const RESUME_MS = 2600    // after a drag, tap or hover the rail waits this long before gliding again
const DRAG_PX = 6         // movement before a press becomes a drag (below it, it is a tap on the tile)

/**
 * The way into Discover's categories: a row of cards that glides slowly to the left on its own and loops. The motion is a
 * GPU transform advanced by fractional pixels every frame (no scroll-position stepping), so it is perfectly smooth, and the
 * edges fade out. Pressing, hovering or focusing it stops the glide; it can be dragged (with a little momentum), flicked,
 * moved with the arrows or tabbed through, and picks up again a moment later. People who ask for reduced motion get a still
 * row they swipe themselves. Each card is only artwork; its name is written underneath. The second copy that makes the loop
 * seamless is hidden from assistive technology and the keyboard.
 */
export function CategoryRail({ tiles, label = 'Explore categories' }: { tiles: Tile[]; label?: string }) {
  const [calm] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const loop = !calm && tiles.length > 2
  // Every tile's own picture is fetched and decoded once, up front, so the cards are painted when they scroll into view.
  useEffect(() => { for (const t of tiles) if (t.media && !t.media.video) void preload(t.media.url) }, [tiles])
  return loop ? <GlidingRail tiles={tiles} label={label} /> : <StillRail tiles={tiles} label={label} />
}

function GlidingRail({ tiles, label }: { tiles: Tile[]; label: string }) {
  const view = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const st = useRef({ pos: 0, vel: 0, target: null as number | null, held: 0, drag: null as null | { x: number; pos: number; moved: boolean; t: number; lastX: number; lastT: number }, period: 0, moved: false })

  useEffect(() => {
    const el = track.current, vp = view.current
    if (!el || !vp) return
    const s = st.current
    let raf = 0, last = performance.now()
    const measure = () => { const first = el.children[0] as HTMLElement | undefined, copy = el.children[tiles.length] as HTMLElement | undefined; if (first && copy) s.period = copy.offsetLeft - first.offsetLeft }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    const tick = (now: number) => {
      const dt = Math.min(64, now - last); last = now
      if (s.period > 0) {
        if (s.drag) { /* position follows the finger */ }
        else if (s.target != null) { const d = s.target - s.pos; s.pos += d * Math.min(1, dt / 130); if (Math.abs(d) < 0.4) { s.pos = s.target; s.target = null } }
        else if (Math.abs(s.vel) > 0.02) { s.pos += s.vel * dt; s.vel *= Math.pow(0.92, dt / 16.7) }
        else if (now > s.held && !document.hidden && s.period > vp.clientWidth) s.pos += (SPEED * dt) / 1000
        if (s.pos >= s.period) { s.pos -= s.period; if (s.target != null) s.target -= s.period }
        else if (s.pos < 0) { s.pos += s.period; if (s.target != null) s.target += s.period }
        el.style.transform = `translate3d(${(-s.pos).toFixed(2)}px,0,0)`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); ro?.disconnect() }
  }, [tiles.length])

  const hold = (ms = RESUME_MS) => { st.current.held = performance.now() + ms }
  const down = (e: RPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const s = st.current; s.vel = 0; s.target = null
    s.drag = { x: e.clientX, pos: s.pos, moved: false, t: performance.now(), lastX: e.clientX, lastT: performance.now() }
    hold(Infinity)
  }
  const move = (e: RPointerEvent) => {
    const s = st.current, d = s.drag
    if (!d) { if (e.pointerType === 'mouse') hold(); return }
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) > DRAG_PX) { d.moved = true; try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* not capturable */ } }
    if (d.moved) {
      s.pos = d.pos - dx
      const now = performance.now(), dtm = now - d.lastT
      if (dtm > 0) s.vel = (d.lastX - e.clientX) / dtm
      d.lastX = e.clientX; d.lastT = now
    }
  }
  const up = () => {
    const s = st.current, d = s.drag
    s.drag = null
    if (d?.moved) { s.moved = true; window.setTimeout(() => { s.moved = false }, 60); if (performance.now() - d.lastT > 80) s.vel = 0 }
    else s.vel = 0
    hold()
  }
  const arrow = (dir: 1 | -1) => { const s = st.current; hold(RESUME_MS * 1.5); s.vel = 0; s.target = (s.target ?? s.pos) + dir * (view.current?.clientWidth ?? 300) * 0.8 }
  const onWheel = (e: React.WheelEvent) => { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const s = st.current; s.target = null; s.pos += e.deltaX; hold() } }
  // Anything that scrolls the clipped viewport itself (the browser bringing a focused or targeted tile into view) is folded back into the glide's own position.
  const fold = (v: HTMLElement) => { if (v.scrollLeft) { const s = st.current; s.pos += v.scrollLeft; v.scrollLeft = 0; s.vel = 0; s.target = null; hold(); if (track.current) track.current.style.transform = `translate3d(${(-s.pos).toFixed(2)}px,0,0)` } }
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => fold(e.currentTarget)
  // Keyboard: a focused tile is brought into view, and the glide stays put until focus leaves.
  const onFocus = (e: React.FocusEvent) => {
    const s = st.current, vp = view.current; if (!vp) return
    hold(Infinity); fold(vp)
    const t = (e.target as HTMLElement).closest('.crail-item') as HTMLElement | null
    if (t && (e.target as HTMLElement).matches(':focus-visible')) {      // a mouse press focuses too, but must not move the row under the pointer
      const left = t.offsetLeft - 16; if (left < s.pos || left + t.offsetWidth > s.pos + vp.clientWidth) { s.vel = 0; s.target = left } }
  }

  return (
    <nav className="crail gliding" aria-label={label}>
      <button type="button" className="crail-arrow prev" aria-label="Previous categories" onClick={() => arrow(-1)}><ChevronLeft size={20} /></button>
      <div ref={view} className="crail-view" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={e => { if (e.pointerType === 'mouse' && !st.current.drag) hold(600) }}
        onWheel={onWheel} onFocus={onFocus} onScroll={onScroll} onBlur={() => hold()} onClickCapture={e => { if (st.current.moved) { e.preventDefault(); e.stopPropagation() } }} onDragStart={e => e.preventDefault()}>
        <div ref={track} className="crail-track">
          {tiles.map(t => <TileLink key={t.id} t={t} />)}
          {tiles.map(t => <TileLink key={`copy-${t.id}`} t={t} copy />)}
        </div>
      </div>
      <button type="button" className="crail-arrow next" aria-label="More categories" onClick={() => arrow(1)}><ChevronRight size={20} /></button>
    </nav>
  )
}

/** Reduced motion (or very few tiles): an ordinary swipeable row, no automatic movement. */
function StillRail({ tiles, label }: { tiles: Tile[]; label: string }) {
  return (
    <nav className="crail" aria-label={label}>
      <div className="crail-list">{tiles.map(t => <TileLink key={t.id} t={t} />)}</div>
    </nav>
  )
}

function TileLink({ t, copy = false }: { t: Tile; copy?: boolean }) {
  const eventArt = useSigned(t.media ? null : t.art ?? null)
  const src = t.media && !t.media.video ? t.media.url : eventArt
  const ok = useReadyImage(src)
  return (
    <Link to={`/app/discover/c/${t.id}`} className="crail-item" aria-hidden={copy || undefined} tabIndex={copy ? -1 : undefined} draggable={false} style={{ ['--tile' as string]: t.accent }}>
      <span className={`crail-tile${ok || t.media ? ' has-art' : ''}`} style={ok && src ? { backgroundImage: `url(${src})` } : undefined}>
        {t.media?.video && <video className="crail-video" src={t.media.url} muted loop autoPlay playsInline preload="auto" aria-hidden />}
      </span>
      <span className="crail-label clamp-2">{t.label}</span>
    </Link>
  )
}
