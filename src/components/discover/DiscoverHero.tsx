import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { HOUSE_COPY, promoUrl, safeLink, slideLabel, track, useDiscoverHero, useReducedMotion, type PromoSlide } from '../../lib/promos'
import { HouseSlide } from '../HomeBillboard'

const AUTOPLAY_MS = 7000

/**
 * The hero at the top of Discover. Its slides are admin-managed promo slides with placement "discover" (live and inside their
 * dates, enforced by RLS), configured separately from the Home billboard. With none live it shows VYBE's own card. Autoplay
 * pauses on hover, focus and touch, and is off for reduced-motion users; every slide can be reached with the buttons or arrow keys.
 */
export function DiscoverHero() {
  const { slides, loading } = useDiscoverHero()
  const [i, setI] = useState(0)
  const [paused, setPaused] = useState(false)
  const [held, setHeld] = useState(false)
  const reduce = useReducedMotion()
  const n = slides.length
  const cur: PromoSlide | undefined = slides[Math.min(i, Math.max(n - 1, 0))]
  const playing = n > 1 && !paused && !held && !reduce
  const touch = useRef<number | null>(null)

  useEffect(() => { if (i >= n) setI(0) }, [n, i])
  useEffect(() => { if (!playing) return; const t = setTimeout(() => setI(x => (x + 1) % n), AUTOPLAY_MS); return () => clearTimeout(t) }, [playing, i, n])
  useEffect(() => { if (cur) track(cur.id, 'impression') }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = (d: number) => setI(x => (x + d + n) % n)

  if (loading) return <div className="dhero skeleton" aria-hidden />
  if (!cur) return <section className="dhero" aria-label="Featured on Discover"><HouseSlide copy={HOUSE_COPY.discover} /></section>

  return (
    <section className="dhero" aria-roledescription="carousel" aria-label="Featured on Discover"
      onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}
      onKeyDown={e => { if (n > 1 && e.key === 'ArrowRight') go(1); else if (n > 1 && e.key === 'ArrowLeft') go(-1) }}
      onTouchStart={e => { touch.current = e.touches[0].clientX; setHeld(true) }}
      onTouchEnd={e => { const dx = e.changedTouches[0].clientX - (touch.current ?? e.changedTouches[0].clientX); touch.current = null; setHeld(false); if (n > 1 && Math.abs(dx) > 40) go(dx < 0 ? 1 : -1) }}>
      <div className="bb-stage" role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${n}`} aria-live={playing ? 'off' : 'polite'}>
        <HeroSlide key={cur.id} s={cur} />
      </div>
      {n > 1 && <>
        <div className="bb-tools"><button className="bb-btn" aria-label={paused ? 'Play slideshow' : 'Pause slideshow'} aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? <Play size={16} /> : <Pause size={16} />}</button></div>
        <button className="bb-nav prev" aria-label="Previous slide" onClick={() => go(-1)}><ChevronLeft size={20} /></button>
        <button className="bb-nav next" aria-label="Next slide" onClick={() => go(1)}><ChevronRight size={20} /></button>
        <div className="bb-dots">{slides.map((s, k) => <button key={s.id} className={k === i ? 'on' : ''} aria-label={`Show slide ${k + 1}`} aria-current={k === i} onClick={() => setI(k)} />)}</div>
      </>}
    </section>
  )
}

function HeroSlide({ s }: { s: PromoSlide }) {
  const link = safeLink(s.cta_url)
  const src = s.media_path ? promoUrl(s.media_path) : null
  const pos = `${s.focal_x}% ${s.focal_y}%`
  const paid = s.label !== 'house' && s.label !== 'announcement'
  const body = (
    <>
      {src && s.media_type === 'image' && <img className="bb-media" src={src} alt="" style={{ objectPosition: pos }} decoding="async" />}
      {src && s.media_type === 'video' && <video className="bb-media" src={src} poster={s.poster_path ? promoUrl(s.poster_path) : undefined} autoPlay loop muted playsInline preload="metadata" style={{ objectPosition: pos }} />}
      <span className="bb-shade" aria-hidden />
      <div className="bb-copy">
        <span className={`bb-eyebrow${paid ? ' bb-ad' : ''}`}>{slideLabel(s)}</span>
        <h2 className="bb-title clamp-2">{s.title}</h2>
        {s.subtitle && <p className="bb-sub clamp-2">{s.subtitle}</p>}
        <span className="bb-row"><span className="bb-cta">{s.cta_label}</span></span>
      </div>
    </>
  )
  const style = { background: `linear-gradient(135deg, ${s.accent}, #15102e)` }
  if (!link) return <div className="bb-slide" style={style}>{body}</div>
  return link.external
    ? <a className="bb-slide" style={style} href={link.href} target="_blank" rel={`noopener noreferrer${paid ? ' sponsored' : ''}`} onClick={() => track(s.id, 'click')}>{body}</a>
    : <Link className="bb-slide" style={style} to={link.href} onClick={() => track(s.id, 'click')}>{body}</Link>
}
