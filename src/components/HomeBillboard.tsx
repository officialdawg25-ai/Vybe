import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Flame, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { formatEventTime } from '../lib/format'
import { money } from '../lib/tickets'
import { playSound } from '../lib/sounds'
import { HOUSE, promoUrl, safeLink, slideLabel, track, useBillboard, useBillboardSound, useInView, useReducedMotion, type BillboardItem, type Placement, type PromoSlide, type TrendingEvent } from '../lib/promos'
import type { Place } from '../lib/location'
import { useSigned } from '../ui'

/**
 * The Home billboard: the screen between the header and the composer. Trending plans near you, interleaved with slides
 * placed on Home (sponsored, VYBE's own, or announcements, each labelled as such).
 */
export function HomeBillboard({ place }: { place: Place }) {
  return <Billboard place={place} placement="home" label="Trending and featured" />
}

/** The Discover hero: slides placed on Discover only (no trending mix), above the Discover sections. */
export function DiscoverHero({ place }: { place: Place }) {
  return <Billboard place={place} placement="discover" label="Featured on Discover" />
}

/**
 * Shared carousel for both placements. Sized from the viewport, pauses on hover/focus/touch and for reduced-motion users,
 * and plays a soft stinger when a slide appears. Video audio only starts after the member taps the speaker. When nothing
 * is live it shows VYBE's own house slide instead of an empty box, and an impression counts only while it is on screen.
 */
function Billboard({ place, placement, label }: { place: Place; placement: Placement; label: string }) {
  const { items: loaded, settings, loading } = useBillboard(place, placement)
  const items = loaded.length || loading ? loaded : [{ kind: 'sponsored', key: `h-${placement}`, slide: HOUSE[placement] } as BillboardItem]
  const box = useRef<HTMLElement>(null)
  const seen = useInView(box)
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  const [held, setHeld] = useState(false)
  const [soundOn, setSoundOn] = useBillboardSound()
  const [audible, setAudible] = useState(false)           // video audio: only after an explicit tap this visit
  const reduce = useReducedMotion()
  const n = items.length
  const cur: BillboardItem | undefined = items[Math.min(i, Math.max(n - 1, 0))]
  const playing = !paused && !held && !reduce && n > 1
  const first = useRef(true)
  const opening = useRef<string | null>(null), moved = useRef(false)

  useEffect(() => { if (i >= n) setI(0) }, [n, i])
  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setI(x => (x + 1) % n), settings.autoplay_ms)
    return () => clearTimeout(t)
  }, [playing, i, n, settings.autoplay_ms])

  // Impression + stinger whenever a slide becomes the visible one. The very first paint is silent (browsers block it anyway, and it would surprise).
  useEffect(() => { if (cur?.kind === 'sponsored' && seen) track(cur.slide.id, 'impression') }, [cur?.key, seen]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!cur) return
    if (first.current) { first.current = false; return }
    if (!soundOn) return
    if (cur.kind === 'trending') playSound('trend')
    else if (cur.slide.sound === 'chime') playSound('spotlight')
  }, [cur?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((d: number) => setI(x => (x + d + n) % n), [n])
  const touch = useRef<number | null>(null)

  if (loading) return <div className={`billboard billboard-skel skeleton bb-${placement}`} aria-hidden />
  if (!cur) return null
  // The first slide appears with the page instead of fading in (a fade only makes the largest thing on screen arrive later);
  // every slide after it keeps the transition.
  opening.current ??= cur.key
  if (cur.key !== opening.current) moved.current = true
  const still = !moved.current

  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next); setAudible(next)
    if (next) playSound('success')
  }

  return (
    <section ref={box} className={`billboard bb-${placement}`} aria-roledescription="carousel" aria-label={label}
      onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
      onKeyDown={e => { if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1) }}
      onTouchStart={e => { touch.current = e.touches[0].clientX; setHeld(true) }}
      onTouchEnd={e => {
        const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX)
        touch.current = null; setHeld(false)
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
      }}>
      <div className={`bb-stage${still ? ' still' : ''}`} aria-live={playing ? 'off' : 'polite'} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${n}`}>
        {cur.kind === 'trending' ? <TrendingSlide key={cur.key} e={cur.event} city={place.name} /> : <SponsoredSlide key={cur.key} s={cur.slide} audible={audible && soundOn} />}
      </div>

      <div className="bb-tools">
        {n > 1 && <button className="bb-btn" aria-label={paused ? 'Play slideshow' : 'Pause slideshow'} aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? <Play size={16} /> : <Pause size={16} />}</button>}
        <button className="bb-btn" aria-label={soundOn ? 'Mute billboard sounds' : 'Turn on billboard sounds'} aria-pressed={soundOn} onClick={toggleSound}>{soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
      </div>
      {n > 1 && <>
        <button className="bb-nav prev" aria-label="Previous slide" onClick={() => go(-1)}><ChevronLeft size={20} /></button>
        <button className="bb-nav next" aria-label="Next slide" onClick={() => go(1)}><ChevronRight size={20} /></button>
        <div className="bb-dots">
          {items.map((it, k) => <button key={it.key} className={k === i ? 'on' : ''} aria-label={`Show slide ${k + 1}`} aria-current={k === i} onClick={() => setI(k)} />)}
        </div>
        {playing && <span key={`${cur.key}-${i}`} className="bb-progress" style={{ animationDuration: `${settings.autoplay_ms}ms` }} aria-hidden />}
      </>}
    </section>
  )
}

function TrendingSlide({ e, city }: { e: TrendingEvent; city: string }) {
  const cover = useSigned(e.cover_path)
  const where = [e.venue, e.city].filter(Boolean).join(', ')
  return (
    <Link to={`/app/plans/${e.id}`} className="bb-slide bb-trend" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
      <span className="bb-shade" aria-hidden />
      <div className="bb-copy">
        <span className="bb-eyebrow">{e.trending ? <><Flame size={14} aria-hidden /> Trending near {city.replace(/^Near /, '')}</> : 'Coming up near you'}</span>
        <h2 className="bb-title clamp-2">{e.title}</h2>
        <p className="bb-sub clamp-1">{formatEventTime(e.starts_at, e.timezone)}{where ? ` · ${where}` : ''}</p>
        <span className="bb-row">
          {e.going > 0 && <span className="bb-pill">{e.going} going</span>}
          {e.price_from_cents != null && <span className="bb-pill">{e.price_from_cents === 0 ? 'Free' : `From ${money(e.price_from_cents)}`}</span>}
          <span className="bb-cta">View plan</span>
        </span>
      </div>
    </Link>
  )
}

export function SponsoredSlide({ s, audible }: { s: PromoSlide; audible: boolean }) {
  const link = safeLink(s.cta_url)
  const src = s.media_path ? promoUrl(s.media_path) : null
  const poster = s.poster_path ? promoUrl(s.poster_path) : undefined
  const pos = `${s.focal_x}% ${s.focal_y}%`
  const body = (
    <>
      {src && s.media_type === 'image' && <img className="bb-media" src={src} alt="" style={{ objectPosition: pos }} decoding="async" />}
      {src && s.media_type === 'video' && <video className="bb-media" src={src} poster={poster} autoPlay loop muted={!audible} playsInline preload="metadata" style={{ objectPosition: pos }} />}
      <span className="bb-shade" aria-hidden />
      <div className="bb-copy">
        <span className={`bb-eyebrow${s.kind === 'house' || s.kind === 'announcement' ? ' bb-house' : ' bb-ad'}`}>{slideLabel(s)}</span>
        <h2 className="bb-title clamp-2">{s.title}</h2>
        {s.subtitle && <p className="bb-sub clamp-2">{s.subtitle}</p>}
        <span className="bb-row"><span className="bb-cta">{s.cta_label}</span></span>
      </div>
    </>
  )
  const style = { background: `linear-gradient(135deg, ${s.accent}, #15102e)`, ['--bb-accent' as string]: s.accent }
  if (!link) return <div className="bb-slide" style={style}>{body}</div>
  return link.external
    ? <a className="bb-slide" style={style} href={link.href} target="_blank" rel={`noopener noreferrer${s.kind === 'house' || s.kind === 'announcement' ? '' : ' sponsored'}`} onClick={() => track(s.id, 'click')}>{body}</a>
    : <Link className="bb-slide" style={style} to={link.href} onClick={() => track(s.id, 'click')}>{body}</Link>
}
