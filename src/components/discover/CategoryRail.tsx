import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { useSigned } from '../../ui'

export interface Tile { id: string; label: string; icon: LucideIcon; accent: string; art?: string | null }

/**
 * The visual way into Discover: a row of category tiles you swipe through sideways (touch, trackpad or mouse wheel),
 * with the next tile peeking in so it is obvious there is more. It is a tab list: arrow keys, Home and End move between
 * tiles, Enter or a tap chooses one, and on wider screens there are arrow buttons, so swiping is never the only way.
 * Tiles show the cover of a real upcoming plan in that category when there is one, otherwise their own colour and icon.
 */
export function CategoryRail({ tiles, selected, onSelect, label = 'Explore categories' }: { tiles: Tile[]; selected: string; onSelect: (id: string) => void; label?: string }) {
  const list = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: false })
  const measure = () => { const el = list.current; if (el) setEdge({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 }) }
  useEffect(() => { measure(); const r = () => measure(); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r) }, [tiles.length])
  // Keep the chosen tile in view (deep links and back/forward land on it).
  useEffect(() => {
    const el = list.current, tile = el?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el || !tile) return
    const left = tile.offsetLeft - el.offsetLeft, pad = 16
    if (left < el.scrollLeft + pad || left + tile.offsetWidth > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = Math.max(0, left - pad)
    measure()
  }, [selected, tiles.length])
  const page = (dir: 1 | -1) => { const el = list.current; if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : null
    if (to == null) return
    e.preventDefault()
    btns[(to + btns.length) % btns.length]?.focus()
  }
  return (
    <div className="crail">
      {!edge.start && <button type="button" className="crail-arrow prev" aria-label="Previous categories" onClick={() => page(-1)}><ChevronLeft size={20} /></button>}
      <div ref={list} className="crail-list" role="tablist" aria-label={label} onScroll={measure} onKeyDown={onKey}>
        {tiles.map(t => <TileButton key={t.id} t={t} on={t.id === selected} onSelect={onSelect} />)}
      </div>
      {!edge.end && <button type="button" className="crail-arrow next" aria-label="More categories" onClick={() => page(1)}><ChevronRight size={20} /></button>}
    </div>
  )
}

function TileButton({ t, on, onSelect }: { t: Tile; on: boolean; onSelect: (id: string) => void }) {
  const art = useSigned(t.art ?? null)
  const Icon = t.icon
  return (
    <button type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} className={`crail-tile${on ? ' on' : ''}${art ? ' has-art' : ''}`}
      style={{ ['--tile' as string]: t.accent, ...(art ? { backgroundImage: `url(${art})` } : {}) }} onClick={() => onSelect(t.id)}>
      <span className="crail-ico" aria-hidden><Icon size={22} aria-hidden /></span>
      <span className="crail-label">{t.label}</span>
    </button>
  )
}
