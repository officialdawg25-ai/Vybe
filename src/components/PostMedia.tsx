import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { useSigned } from '../ui'

export interface Item { path: string; type: 'image' | 'video'; poster_path?: string | null }

/** Sound preference for videos in the feed, shared across posts. Starts muted (browsers require it); one tap on the speaker unmutes every video. */
let muted = true
const subs = new Set<() => void>()
export const setMuted = (m: boolean) => { muted = m; subs.forEach(f => f()) }
function useMuted() {
  const [m, set] = useState(muted)
  useEffect(() => { const f = () => set(muted); subs.add(f); return () => { subs.delete(f) } }, [])
  return m
}

/**
 * Edge-to-edge media at its original size and proportions. One item shows uncropped; several swipe horizontally with a counter and dots.
 * Double-tap likes. Videos play silently while on screen and pause when scrolled away.
 */
export function PostMedia({ items, onDoubleTap, liked }: { items: Item[]; onDoubleTap: () => void; liked: boolean }) {
  const [i, setI] = useState(0)
  const [burst, setBurst] = useState(0)
  const track = useRef<HTMLDivElement>(null)
  const last = useRef<{ t: number; x: number; y: number } | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)       // width / height of the first item, used to keep a swipe gallery steady
  if (!items.length) return null

  const tap = (e: React.PointerEvent) => {
    const now = Date.now(), p = last.current
    if (p && now - p.t < 320 && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 40) {
      last.current = null; setBurst(b => b + 1)
      if (!liked) onDoubleTap()
    } else last.current = { t: now, x: e.clientX, y: e.clientY }
  }
  const onScroll = () => { const el = track.current; if (el) setI(Math.round(el.scrollLeft / el.clientWidth)) }
  const many = items.length > 1
  const clamped = ratio ? Math.min(1.91, Math.max(0.8, ratio)) : 1

  return (
    <div className="igp-media" onPointerUp={tap} style={many ? { aspectRatio: String(clamped) } : undefined}>
      <div ref={track} className={many ? 'igp-track many' : 'igp-track'} onScroll={many ? onScroll : undefined}>
        {items.map((it, k) => <Slide key={it.path} item={it} first={k === 0} many={many} active={k === i} onRatio={r => k === 0 && setRatio(r)} />)}
      </div>
      {many && <span className="igp-count" aria-hidden>{i + 1}/{items.length}</span>}
      {burst > 0 && <span key={burst} className="igp-burst" aria-hidden>❤️</span>}
      {many && <div className="igp-dots" aria-hidden>{items.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>}
    </div>
  )
}

function Slide({ item, first, many, active, onRatio }: { item: Item; first: boolean; many: boolean; active: boolean; onRatio: (r: number) => void }) {
  const url = useSigned(item.path)
  const poster = useSigned(item.poster_path ?? null)
  const isMuted = useMuted()
  const vid = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = vid.current; if (!v || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && e.intersectionRatio > 0.6 && (!many || active)) void v.play().catch(() => {}); else v.pause() }, { threshold: [0, 0.6] })
    io.observe(v); return () => io.disconnect()
  }, [url, many, active])
  if (!url) return <div className="igp-slide"><span className="skeleton" style={{ display: 'block', width: '100%', aspectRatio: '4 / 5' }} aria-hidden /></div>
  return (
    <div className="igp-slide">
      {item.type === 'video'
        ? <>
            <video ref={vid} src={poster ? url : `${url}#t=0.1`} poster={poster ?? undefined} muted={isMuted} loop playsInline preload="metadata" onLoadedMetadata={e => first && onRatio(e.currentTarget.videoWidth / (e.currentTarget.videoHeight || 1))} />
            <button className="igp-vol" aria-label={isMuted ? 'Turn sound on' : 'Turn sound off'} aria-pressed={!isMuted} onClick={e => { e.stopPropagation(); setMuted(!isMuted) }} onPointerUp={e => e.stopPropagation()}>{isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
          </>
        : <img src={url} alt="" decoding="async" loading="lazy" draggable={false} onLoad={e => first && onRatio(e.currentTarget.naturalWidth / (e.currentTarget.naturalHeight || 1))} />}
    </div>
  )
}
