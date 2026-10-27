import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useSigned } from '../ui'

/**
 * Full-screen photo viewer: the whole photo at its own proportions (never cropped), from the original upload. Pinch or
 * double-tap to zoom, drag to look around while zoomed, swipe (or arrow keys) between photos, Escape / × / a swipe down to
 * close. Opened by a single tap on a photo in a post.
 */
export function MediaViewer({ paths, start, onClose }: { paths: string[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(Math.min(Math.max(0, start), paths.length - 1))
  const close = useRef<HTMLButtonElement>(null)
  const go = (d: number) => setI(k => Math.min(paths.length - 1, Math.max(0, k + d)))
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    close.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; back?.focus?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="pv" role="dialog" aria-modal="true" aria-label={paths.length > 1 ? `Photo ${i + 1} of ${paths.length}` : 'Photo'}>
      <Zoomable key={paths[i]} path={paths[i]} onSwipe={d => (d === 0 ? onClose() : go(d))} />
      <button ref={close} className="pv-close" aria-label="Close" onClick={onClose}><X size={22} /></button>
      {paths.length > 1 && <>
        <span className="pv-count" aria-hidden>{i + 1}/{paths.length}</span>
        {i > 0 && <button className="pv-nav prev" aria-label="Previous photo" onClick={() => go(-1)}><ChevronLeft size={24} /></button>}
        {i < paths.length - 1 && <button className="pv-nav next" aria-label="Next photo" onClick={() => go(1)}><ChevronRight size={24} /></button>}
      </>}
    </div>,
    document.body,
  )
}

/** One photo with pinch / double-tap zoom and panning. `onSwipe(±1)` changes photo, `onSwipe(0)` is a swipe down (close). */
function Zoomable({ path, onSwipe }: { path: string; onSwipe: (d: -1 | 0 | 1) => void }) {
  const url = useSigned(path)
  const [t, setT] = useState({ s: 1, x: 0, y: 0 })
  const [failed, setFailed] = useState(false)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const g = useRef<{ d0: number; s0: number; x0: number; y0: number; sx: number; sy: number; moved: boolean } | null>(null)
  const lastTap = useRef(0)
  const clamp = (s: number) => Math.min(5, Math.max(1, s))
  const dist = () => { const [a, b] = [...pts.current.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 }

  const down = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    g.current = { d0: dist(), s0: t.s, x0: t.x, y0: t.y, sx: e.clientX, sy: e.clientY, moved: false }
  }
  const move = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId) || !g.current) return
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const st = g.current
    if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 8) st.moved = true
    if (pts.current.size >= 2 && st.d0 > 0) setT(v => ({ ...v, s: clamp(st.s0 * dist() / st.d0) }))
    else if (t.s > 1) setT(v => ({ ...v, x: st.x0 + e.clientX - st.sx, y: st.y0 + e.clientY - st.sy }))
  }
  const up = (e: React.PointerEvent) => {
    const st = g.current
    pts.current.delete(e.pointerId)
    if (!st || pts.current.size > 0) { if (st) { g.current = { ...st, d0: 0 } } return }
    g.current = null
    const dx = e.clientX - st.sx, dy = e.clientY - st.sy
    if (!st.moved) {
      const now = Date.now()
      if (now - lastTap.current < 300) { lastTap.current = 0; setT(v => (v.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 })) }
      else lastTap.current = now
      return
    }
    if (t.s <= 1.01) {
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1)
      else if (dy > 90 && dy > Math.abs(dx)) onSwipe(0)
      setT({ s: 1, x: 0, y: 0 })
    }
  }
  const wheel = (e: React.WheelEvent) => { if (e.ctrlKey || e.metaKey) setT(v => ({ ...v, s: clamp(v.s * (e.deltaY < 0 ? 1.15 : 0.87)) })) }

  return (
    <div className="pv-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
      {failed
        ? <p className="pv-msg" role="alert">This photo could not be loaded.</p>
        : url
          ? <img src={url} alt="" draggable={false} onError={() => setFailed(true)}
              style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})` }} />
          : <span className="spinner" aria-label="Loading photo" />}
    </div>
  )
}
