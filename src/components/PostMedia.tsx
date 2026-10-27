import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { useSigned, useSignedState } from '../ui'
import { MediaViewer } from './MediaViewer'
import { Emoji } from './Emoji'
import { problemText, useVideoRecovery } from '../lib/mediaRecovery'
import { markCopyBroken, noteStall, pickContext, pickVideoPath, useBrokenVersion, useStalledLow, useVideoQuality } from '../lib/videoQuality'
import { usePolicy } from '../lib/dataMode'
import { shownPath } from '../lib/feedCache'
import { setFeedMuted, useFeedMuted } from '../lib/feedSound'

/** Frame ratios already measured this session, so a post keeps its shape when it scrolls back into view. */
const known = new Map<string, number>()

export interface Item { path: string; type: 'image' | 'video'; poster_path?: string | null; display_path?: string | null; trim_start_ms?: number | null; trim_end_ms?: number | null; muted?: boolean }

/** Sound in the feed is one switch shared with post songs (lib/feedSound): starts off; one tap turns it on everywhere. */

/**
 * Edge-to-edge media at its original proportions (photos from their phone-sized display copy unless the device is set to High quality). One item shows uncropped; several swipe horizontally with a counter and dots.
 * Double-tap likes, a single tap opens (photo viewer / Reels). Videos play silently while on screen and pause when scrolled away.
 */
/** Only one feed video plays at a time: starting one pauses the previous (less decoding, less data, less battery). */
let playing: HTMLVideoElement | null = null
const claim = (v: HTMLVideoElement) => { if (playing && playing !== v && !playing.paused) playing.pause(); playing = v }

/**
 * `silent`: the post has its own song, so its videos never add their sound on top.
 * `onClock`: receives the video on screen (or null for a photo) so the post's song can follow it (lib/feedSound).
 * `onOpenVideo`: a single tap on a video (or its expand button) opens it full screen in Reels at the same moment.
 * A single tap on a photo opens the photo viewer; a double tap anywhere likes.
 */
export function PostMedia({ items, onDoubleTap, liked, silent = false, onClock, onOpenVideo }: {
  items: Item[]; onDoubleTap: () => void; liked: boolean; silent?: boolean
  onClock?: (v: HTMLVideoElement | null) => void; onOpenVideo?: (index: number, time: number) => void
}) {
  const [i, setI] = useState(0)
  const [burst, setBurst] = useState(0)
  const [viewer, setViewer] = useState<number | null>(null)
  const [els, setEls] = useState<Record<number, HTMLVideoElement | null>>({})
  const track = useRef<HTMLDivElement>(null)
  const last = useRef<{ t: number; x: number; y: number } | null>(null)
  const press = useRef<{ x: number; y: number } | null>(null)
  const single = useRef<number | undefined>(undefined)
  const [ratio, setRatio] = useState<number | null>(() => known.get(items[0]?.path ?? '') ?? null)   // width / height of the first item
  const shown = items[i]?.type === 'video' ? els[i] ?? null : null
  useEffect(() => { onClock?.(shown) }, [shown, onClock])
  useEffect(() => () => { onClock?.(null); window.clearTimeout(single.current) }, [onClock])
  if (!items.length) return null

  const photos = items.filter(it => it.type === 'image')
  const open = (k: number) => {
    const it = items[k]; if (!it) return
    if (it.type === 'video') { if (onOpenVideo) onOpenVideo(k, els[k]?.currentTime ?? 0) }
    else setViewer(photos.indexOf(it))
  }
  const tap = (e: React.PointerEvent) => {
    const p0 = press.current; press.current = null
    if (!p0 || Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > 10) return     // a swipe or a scroll, not a tap
    const now = Date.now(), p = last.current
    if (p && now - p.t < 320 && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 40) {
      window.clearTimeout(single.current)
      last.current = null; setBurst(b => b + 1)
      if (!liked) onDoubleTap()
    } else {
      last.current = { t: now, x: e.clientX, y: e.clientY }
      const k = i
      window.clearTimeout(single.current)
      single.current = window.setTimeout(() => { last.current = null; open(k) }, 330)   // waits out a possible second tap
    }
  }
  const onScroll = () => { const el = track.current; if (el) setI(Math.round(el.scrollLeft / el.clientWidth)) }
  const many = items.length > 1
  // Instagram's rule: the frame follows the first item's proportions but never goes taller than 4:5 or wider than 1.91:1.
  // Media fills the whole frame edge to edge (anything beyond those limits is cropped; tapping a photo opens it whole).
  const clamped = Math.min(1.91, Math.max(0.8, ratio ?? 0.8))
  const setEl = (k: number, v: HTMLVideoElement | null) => setEls(m => (m[k] === v ? m : { ...m, [k]: v }))

  return (
    <div className={many ? 'igp-media many' : 'igp-media'} onPointerDown={e => { press.current = { x: e.clientX, y: e.clientY } }} onPointerUp={tap}
      style={{ aspectRatio: String(clamped) }}>
      <div ref={track} className={many ? 'igp-track many' : 'igp-track'} onScroll={many ? onScroll : undefined}>
        {items.map((it, k) => <Slide key={it.path} item={it} first={k === 0} many={many} active={k === i} onRatio={r => { if (k === 0) { known.set(it.path, r); setRatio(r) } }} silent={silent}
          onVideo={v => setEl(k, v)} onOpen={() => open(k)} canOpen={it.type === 'image' || Boolean(onOpenVideo)} />)}
      </div>
      {many && <span className="igp-count" aria-hidden>{i + 1}/{items.length}</span>}
      {burst > 0 && <span key={burst} className="igp-burst" aria-hidden><Emoji k="heart" /></span>}
      {many && <div className="igp-dots" aria-hidden>{items.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</div>}
      {viewer !== null && photos.length > 0 && <MediaViewer paths={photos.map(p => p.path)} start={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}

const stop = { onClick: (e: React.MouseEvent) => e.stopPropagation(), onPointerUp: (e: React.PointerEvent) => e.stopPropagation(), onPointerDown: (e: React.PointerEvent) => e.stopPropagation() }

/**
 * One slide. A video holds a player only while it is within about two screens of the viewport; further away it becomes its
 * poster (same size, so nothing moves) and the browser can release the decoder and buffered data. With data saver, videos
 * wait for a tap and fetch nothing until then. A playing video shows a thin progress line, a spinner while it buffers and,
 * if it fails, a message with Retry (which asks for a fresh signed address).
 */
function Slide({ item, first, many, active, onRatio, silent, onVideo, onOpen, canOpen }: {
  item: Item; first: boolean; many: boolean; active: boolean; onRatio: (r: number) => void; silent: boolean
  onVideo: (v: HTMLVideoElement | null) => void; onOpen: () => void; canOpen: boolean
}) {
  const policy = usePolicy()
  // Photos: the phone-sized copy unless High quality. Videos: the original or its smaller copy (lib/videoQuality).
  const quality = useVideoQuality(), stalledLow = useStalledLow(); useBrokenVersion()
  const pick = item.type === 'video' ? pickVideoPath(item, quality, pickContext(policy, stalledLow)) : null
  const signed = useSignedState(pick ? pick.path : shownPath(item, policy.originalPhotos))
  const url = !pick || signed.forPath === pick.path ? signed.url : null
  const poster = useSigned(item.poster_path ?? null)
  const feedMuted = useFeedMuted()
  const isMuted = silent || feedMuted || Boolean(item.muted)
  // The author's trim: only this part plays, and it loops inside it.
  const from = (item.trim_start_ms ?? 0) / 1000, to = item.trim_end_ms != null ? item.trim_end_ms / 1000 : null
  const vid = useRef<HTMLVideoElement | null>(null)
  const bar = useRef<HTMLSpanElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(true)
  const [tapped, setTapped] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const auto = policy.autoplayFeedVideo || tapped
  const [onScreen, setOnScreen] = useState(false)
  const rec = useVideoRecovery(signed.refresh, { wanted: item.type === 'video' && auto && onScreen && (!many || active), src: url, file: pick?.path })
  const failed = rec.problem !== null
  const report = useRef(onVideo); report.current = onVideo
  const setVid = useCallback((v: HTMLVideoElement | null) => { vid.current = v; report.current(v) }, [])   // stable, or React would re-attach it every render
  useEffect(() => {
    const el = box.current; if (!el || item.type !== 'video' || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '200% 0px' })
    io.observe(el); return () => io.disconnect()
  }, [item.type, url])                       // the box exists only once the signed address has arrived
  useEffect(() => {
    const v = vid.current; if (!v || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => { const vis = e.isIntersecting && e.intersectionRatio > 0.6; setOnScreen(vis); if (auto && vis && (!many || active)) { claim(v); void v.play().catch(() => {}) } else v.pause() }, { threshold: [0, 0.6] })
    io.observe(v); return () => io.disconnect()
  }, [url, many, active, auto, near, failed, rec.attempt])
  if (!url) return <div className="igp-slide"><span className="skeleton igp-fill" aria-hidden /></div>
  if (item.type !== 'video') return (
    <div className="igp-slide">
      <img src={url} alt="" decoding="async" loading="lazy" draggable={false} onLoad={e => first && onRatio(e.currentTarget.naturalWidth / (e.currentTarget.naturalHeight || 1))} />
      <button className="sr-only" onClick={onOpen}>Open photo</button>
    </div>
  )
  const retry = () => { setBuffering(false); rec.retry() }
  return (
    <div className="igp-slide" ref={box}>
      {near && auto && !failed
        ? <>
            <video key={`${rec.attempt}:${pick?.path}`} ref={setVid} src={item.poster_path ? rec.src ?? url : `${rec.src ?? url}#t=${Math.max(0.1, from)}`} poster={poster ?? undefined} muted={isMuted} loop playsInline preload={auto ? 'metadata' : 'none'}
              onPlay={e => claim(e.currentTarget)}
              onWaiting={e => { setBuffering(true); if (e.currentTarget.currentTime > 0) noteStall() }} onPlaying={() => { setBuffering(false); rec.onPlaying() }} onPause={() => setBuffering(false)} onCanPlay={() => setBuffering(false)}
              onError={() => { setBuffering(false); if (pick?.small && item.display_path) markCopyBroken(item.display_path); else rec.onError() }}
              onTimeUpdate={e => { const v = e.currentTarget; if (to != null && v.currentTime >= to) { v.currentTime = from; if (v.paused) void v.play().catch(() => {}) } rec.mark(v.currentTime); const span = (to ?? v.duration) - from; if (bar.current && span > 0) bar.current.style.transform = `scaleX(${Math.min(1, Math.max(0, (v.currentTime - from) / span))})` }}
              onLoadedMetadata={e => { const v = e.currentTarget, r = v.videoWidth / (v.videoHeight || 1); if (first) onRatio(r); if (rec.resumeAt > 0) v.currentTime = rec.resumeAt; else if (from > 0) v.currentTime = from }} />
            <span className="igp-progress" aria-hidden><span ref={bar} /></span>
            {buffering && !rec.slow && <span className="igp-buffer" role="status" aria-label="Loading video" />}
            {rec.slow && <div className="igp-slow" role="status"><span>Taking longer than usual…</span><button className="btn" {...stop} onClick={e => { e.stopPropagation(); retry() }}><RotateCcw size={16} aria-hidden /> Retry</button></div>}
            {canOpen && <button className="igp-expand" aria-label="Open video full screen" {...stop} onClick={e => { e.stopPropagation(); onOpen() }}><Maximize2 size={16} /></button>}
            {!silent && !item.muted && <button className="igp-vol" aria-label={isMuted ? 'Turn sound on' : 'Turn sound off'} aria-pressed={!isMuted} {...stop} onClick={e => { e.stopPropagation(); setFeedMuted(!feedMuted) }}>{isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>}
          </>
        : <div className="igp-poster" style={poster ? { backgroundImage: `url(${poster})` } : undefined}>
            {failed
              ? <div className="igp-failed" role="alert"><span>{problemText(rec.problem)}</span><button className="btn" {...stop} onClick={e => { e.stopPropagation(); retry() }}><RotateCcw size={16} aria-hidden /> Retry</button></div>
              : !auto && <button className="igp-play" aria-label="Play video" {...stop} onClick={e => { e.stopPropagation(); setTapped(true) }}><Play size={26} fill="currentColor" /></button>}
          </div>}
    </div>
  )
}
