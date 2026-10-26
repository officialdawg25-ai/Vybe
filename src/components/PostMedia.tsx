import { useEffect, useRef, useState } from 'react'
import { Play, Volume2, VolumeX } from 'lucide-react'
import { useSigned } from '../ui'
import { usePolicy } from '../lib/dataMode'
import { shownPath } from '../lib/feedCache'
import { setFeedMuted, useFeedMuted } from '../lib/feedSound'

export interface Item { path: string; type: 'image' | 'video'; poster_path?: string | null; display_path?: string | null }

/** Sound in the feed is one switch shared with post songs (lib/feedSound): starts off; one tap turns it on everywhere. */

/**
 * Edge-to-edge media at its original proportions (photos from their phone-sized display copy unless the device is set to High quality). One item shows uncropped; several swipe horizontally with a counter and dots.
 * Double-tap likes. Videos play silently while on screen and pause when scrolled away.
 */
/** Only one feed video plays at a time: starting one pauses the previous (less decoding, less data, less battery). */
let playing: HTMLVideoElement | null = null
const claim = (v: HTMLVideoElement) => { if (playing && playing !== v && !playing.paused) playing.pause(); playing = v }

/** `silent`: the post has its own song, so its videos never add their sound on top. */
export function PostMedia({ items, onDoubleTap, liked, silent = false }: { items: Item[]; onDoubleTap: () => void; liked: boolean; silent?: boolean }) {
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
        {items.map((it, k) => <Slide key={it.path} item={it} first={k === 0} many={many} active={k === i} onRatio={r => k === 0 && setRatio(r)} silent={silent} />)}
      </div>
      {many && <span className="igp-count" aria-hidden>{i + 1}/{items.length}</span>}
      {burst > 0 && <span key={burst} className="igp-burst" aria-hidden>❤️</span>}
      {many && <div className="igp-dots" aria-hidden>{items.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>}
    </div>
  )
}

/**
 * One slide. A video holds a player only while it is within about two screens of the viewport; further away it becomes its
 * poster (same size, so nothing moves) and the browser can release the decoder and buffered data. With data saver, videos
 * wait for a tap and fetch nothing until then.
 */
function Slide({ item, first, many, active, onRatio, silent }: { item: Item; first: boolean; many: boolean; active: boolean; onRatio: (r: number) => void; silent: boolean }) {
  const policy = usePolicy()
  const url = useSigned(shownPath(item, policy.originalPhotos))
  const poster = useSigned(item.poster_path ?? null)
  const feedMuted = useFeedMuted()
  const isMuted = silent || feedMuted
  const vid = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(true)
  const [ratio, setRatio] = useState<number | null>(null)
  const [tapped, setTapped] = useState(false)
  const auto = policy.autoplayFeedVideo || tapped
  useEffect(() => {
    const el = box.current; if (!el || item.type !== 'video' || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '200% 0px' })
    io.observe(el); return () => io.disconnect()
  }, [item.type, url])                       // the box exists only once the signed address has arrived
  useEffect(() => {
    const v = vid.current; if (!v || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => { if (auto && e.isIntersecting && e.intersectionRatio > 0.6 && (!many || active)) { claim(v); void v.play().catch(() => {}) } else v.pause() }, { threshold: [0, 0.6] })
    io.observe(v); return () => io.disconnect()
  }, [url, many, active, auto, near])
  if (!url) return <div className="igp-slide"><span className="skeleton" style={{ display: 'block', width: '100%', aspectRatio: '4 / 5' }} aria-hidden /></div>
  if (item.type !== 'video') return (
    <div className="igp-slide">
      <img src={url} alt="" decoding="async" loading="lazy" draggable={false} onLoad={e => first && onRatio(e.currentTarget.naturalWidth / (e.currentTarget.naturalHeight || 1))} />
    </div>
  )
  const keep = { aspectRatio: String(ratio ?? 4 / 5) }
  return (
    <div className="igp-slide" ref={box}>
      {near && auto
        ? <>
            <video ref={vid} src={poster ? url : `${url}#t=0.1`} poster={poster ?? undefined} muted={isMuted} loop playsInline preload={auto ? 'metadata' : 'none'}
              onPlay={e => claim(e.currentTarget)}
              onLoadedMetadata={e => { const r = e.currentTarget.videoWidth / (e.currentTarget.videoHeight || 1); setRatio(r); if (first) onRatio(r) }} />
            {!silent && <button className="igp-vol" aria-label={isMuted ? 'Turn sound on' : 'Turn sound off'} aria-pressed={!isMuted} onClick={e => { e.stopPropagation(); setFeedMuted(!feedMuted) }} onPointerUp={e => e.stopPropagation()}>{isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>}
          </>
        : <div className="igp-poster" style={{ ...keep, ...(poster ? { backgroundImage: `url(${poster})` } : {}) }}>
            {!auto && <button className="igp-play" aria-label="Play video" onClick={e => { e.stopPropagation(); setTapped(true) }} onPointerUp={e => e.stopPropagation()}><Play size={26} fill="currentColor" /></button>}
          </div>}
    </div>
  )
}
