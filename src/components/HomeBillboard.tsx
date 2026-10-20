import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Flame, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { formatEventTime } from '../lib/format'
import { money } from '../lib/tickets'
import { playSound } from '../lib/sounds'
import { promoUrl, safeLink, track, useBillboard, useBillboardSound, useReducedMotion, type BillboardItem, type PromoSlide, type TrendingEvent } from '../lib/promos'
import type { Place } from '../lib/location'
import { useSigned } from '../ui'

/**
 * The screen between the header and the composer: trending plans near you, interleaved with admin-managed sponsored slides.
 * Sized from the viewport (never taller than ~30% of the screen), pauses on hover/focus/touch and for reduced-motion users,
 * and plays a soft stinger when a slide appears. Video audio only starts after the member taps the speaker.
 */
export function HomeBillboard({ place }: { place: Place }) {
  const { items, settings, loading } = useBillboard(place)
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

  useEffect(() => { if (i >= n) setI(0) }, [n, i])
  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setI(x => (x + 1) % n), settings.autoplay_ms)
    return () => clearTimeout(t)
  }, [playing, i, n, settings.autoplay_ms])

  // Impression + stinger whenever a slide becomes the visible one. The very first paint is silent (browsers block it anyway, and it would surprise).
  useEffect(() => {
    if (!cur) return
    if (cur.kind === 'sponsored') track(cur.slide.id, 'impression')
    if (first.current) { first.current = false; return }
    if (!soundOn) return
    if (cur.kind === 'trending') playSound('trend')
    else if (cur.slide.sound === 'chime') playSound('spotlight')
  }, [cur?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((d: number) => setI(x => (x + d + n) % n), [n])
  const touch = useRef<number | null>(null)

  if (loading) return <div className="billboard billboard-skel skeleton" aria-hidden />
  if (!cur) return null

  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next); setAudible(next)
    if (next) playSound('success')
  }

  return (
    <section className="billboard" aria-roledescription="carousel" aria-label="Trending and featured"
      onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
      onKeyDown={e => { if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1) }}
      onTouchStart={e => { touch.current = e.touches[0].clientX; setHeld(true) }}
      onTouchEnd={e => {
        const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX)
        touch.current = null; setHeld(false)
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
      }}>
      <div className="bb-stage" aria-live={playing ? 'off' : 'polite'} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${n}`}>
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

function SponsoredSlide({ s, audible }: { s: PromoSlide; audible: boolean }) {
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
        <span className="bb-eyebrow bb-ad">Sponsored{s.advertiser ? ` · ${s.advertiser}` : ''}</span>
        <h2 className="bb-title clamp-2">{s.title}</h2>
        {s.subtitle && <p className="bb-sub clamp-2">{s.subtitle}</p>}
        <span className="bb-row"><span className="bb-cta">{s.cta_label}</span></span>
      </div>
    </>
  )
  const style = { background: `linear-gradient(135deg, ${s.accent}, #15102e)`, ['--bb-accent' as string]: s.accent }
  if (!link) return <div className="bb-slide" style={style}>{body}</div>
  return link.external
    ? <a className="bb-slide" style={style} href={link.href} target="_blank" rel="noopener noreferrer sponsored" onClick={() => track(s.id, 'click')}>{body}</a>
    : <Link className="bb-slide" style={style} to={link.href} onClick={() => track(s.id, 'click')}>{body}</Link>
}
