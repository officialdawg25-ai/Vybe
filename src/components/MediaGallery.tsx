import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Play, X } from 'lucide-react'
import { Media, useSigned } from '../ui'

export interface Item { path: string; type: 'image' | 'video' }

/** One item keeps its natural proportions (never cropped). Several become a tidy grid; tapping opens a swipeable full-screen viewer. */
export function MediaGallery({ items }: { items: Item[] }) {
  const [open, setOpen] = useState<number | null>(null)
  if (!items.length) return null
  if (items.length === 1) return <div className="post-media"><Media path={items[0].path} type={items[0].type} /></div>
  const shown = items.slice(0, 4), extra = items.length - shown.length
  return (
    <>
      <ul className={`mg n${shown.length}`} aria-label={`${items.length} photos and videos`}>
        {shown.map((it, i) => (
          <li key={it.path}>
            <button className="mg-cell" onClick={() => setOpen(i)} aria-label={`Open ${it.type} ${i + 1} of ${items.length}`}><Thumb item={it} />
              {i === shown.length - 1 && extra > 0 && <span className="mg-more">+{extra}</span>}</button>
          </li>
        ))}
      </ul>
      {open !== null && <Viewer items={items} start={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function Thumb({ item }: { item: Item }) {
  const url = useSigned(item.path)
  if (!url) return <span className="skeleton mg-skel" aria-hidden />
  return item.type === 'video'
    ? <><video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden /><span className="mg-play" aria-hidden><Play size={22} fill="currentColor" /></span></>
    : <img src={url} alt="" loading="lazy" decoding="async" />
}

function Viewer({ items, start, onClose }: { items: Item[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start)
  const touch = useRef<number | null>(null)
  const url = useSigned(items[i].path)
  const go = (d: number) => setI(x => (x + d + items.length) % items.length)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1) }
    document.addEventListener('keydown', k); const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = prev }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="mv" role="dialog" aria-modal="true" aria-label={`Photo ${i + 1} of ${items.length}`}
      onTouchStart={e => { touch.current = e.touches[0].clientX }} onTouchEnd={e => { const dx = e.changedTouches[0].clientX - (touch.current ?? 0); if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1) }}>
      <button className="mv-x" aria-label="Close" onClick={onClose}><X size={26} /></button>
      <div className="mv-stage">{!url ? <span className="skeleton" style={{ width: 200, height: 200 }} /> : items[i].type === 'video' ? <video key={url} src={url} controls autoPlay playsInline /> : <img src={url} alt="" />}</div>
      <button className="mv-nav prev" aria-label="Previous" onClick={() => go(-1)}><ChevronLeft size={28} /></button>
      <button className="mv-nav next" aria-label="Next" onClick={() => go(1)}><ChevronRight size={28} /></button>
      <span className="mv-count" aria-live="polite">{i + 1} / {items.length}</span>
    </div>
  )
}
