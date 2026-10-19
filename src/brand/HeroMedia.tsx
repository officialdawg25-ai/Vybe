import { useEffect, useState, type ReactNode } from 'react'
import { VMark, Wordmark } from './Logo'
import { prefersReducedMotion, publicBrandUrl, saveDataOn, useMinWidth, type AuthHero } from '../lib/hero'

/**
 * Hero backdrop: administrator-managed image/video with a contrast overlay, or the built-in default art.
 * It never blocks the page: a failed or slow asset falls back to a poster, then to the default art.
 * `src` overrides let the admin preview use draft (signed) URLs instead of the public bucket.
 */
export function HeroMedia({ hero, src, poster, allowVideo = true, wide: wideOverride, children, className = '' }: {
  hero: AuthHero | null
  src?: string
  poster?: string
  allowVideo?: boolean
  /** Admin preview: pretend the viewport is wide (or narrow) regardless of the real one. */
  wide?: boolean
  children?: ReactNode
  className?: string
}) {
  const realWide = useMinWidth(900)
  const wide = wideOverride ?? realWide
  const [failed, setFailed] = useState(false)
  // `src`/`poster` (admin preview) replace the public URLs; an empty string means "not signed yet", never "use the public copy".
  const url = hero?.path ? (src !== undefined ? src || null : publicBrandUrl(hero.path)) : null
  const posterUrl = hero?.poster_path ? (poster !== undefined ? poster || null : publicBrandUrl(hero.poster_path)) : null
  useEffect(() => setFailed(false), [url])
  const pos = hero ? `${hero.focal_x}% ${hero.focal_y}%` : '50% 50%'
  const canPlay = hero?.media_type === 'video' && allowVideo && wide && !prefersReducedMotion() && !saveDataOn() && !failed
  const still = hero?.media_type === 'image' ? url : posterUrl
  const hasMedia = Boolean(url) && !failed && (canPlay || still)

  return (
    <div className={`hero-media ${className}`}>
      <div className="hero-art" aria-hidden="true"><VMark size={420} tone="light" className="hero-art-v" /></div>
      {hasMedia && !canPlay && still && <img className="hero-fill" src={still} alt="" style={{ objectPosition: pos }} onError={() => setFailed(true)} decoding="async" />}
      {hasMedia && canPlay && url && (
        <video className="hero-fill" src={url} poster={posterUrl ?? undefined} style={{ objectPosition: pos }}
          muted loop autoPlay playsInline preload="metadata" aria-hidden="true" onError={() => setFailed(true)} />
      )}
      {hasMedia && <div className="hero-shade" style={{ opacity: (hero?.overlay ?? 45) / 100 }} aria-hidden="true" />}
      {children}
    </div>
  )
}

/** Wordmark + headline + supporting copy, laid over HeroMedia (shared by the sign-in page and the admin preview). */
export function HeroContent({ headline, body, logoHref }: { headline: string; body: string; logoHref?: ReactNode }) {
  const logo = <Wordmark height={30} tone="light" />
  return (
    <div className="auth-hero-inner">
      {logoHref ?? logo}
      <div className="auth-hero-copy">
        {headline && <p className="auth-hero-headline">{headline}</p>}
        {body && <p className="auth-hero-body">{body}</p>}
      </div>
    </div>
  )
}
