import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { BOUNDS, LETTERS, TAGLINE } from './Logo'
import { LOGIN_EVENT, SPLASH_MS, markSplashSeen, readSplashInput, setSignedInHint, splashMode, type SplashMode } from './splash'

/** Distance (in wordmark units) the lone V starts from the right of its final position: it begins centred. */
const V_FROM = BOUNDS.x + BOUNDS.w / 2 - LETTERS[0].w / 2 - LETTERS[0].x
/** YBE enter from the right by this much while their outlines are drawn. */
const YBE_FROM = 380

/**
 * Entrance animation: the V is drawn on its own, slides left into place, then Y-B-E slide in from the right
 * and are drawn; the finished wordmark gets a single soft pulse and the overlay fades away.
 * It sits above the app (nothing waits on it), plays at most once per session on `/`, and can be skipped.
 */
export function SplashGate() {
  const { pathname } = useLocation()
  const { loading, session } = useAuth()
  // Decided once, at first paint: later route changes never replay it.
  const [mode, setMode] = useState<SplashMode>(() => splashMode(readSplashInput(pathname)))
  useEffect(() => { if (mode !== 'none') markSplashSeen() }, [mode])
  useEffect(() => { if (!loading) setSignedInHint(Boolean(session)) }, [loading, session])
  // The full entrance plays on every sign-in (the sign-in page announces it once the password has been accepted).
  useEffect(() => {
    const onLogin = () => setMode(readSplashInput('/').reducedMotion ? 'reduced' : 'full')
    window.addEventListener(LOGIN_EVENT, onLogin)
    return () => window.removeEventListener(LOGIN_EVENT, onLogin)
  }, [])
  if (mode === 'none') return null
  return <Splash key={mode} mode={mode} onDone={() => setMode('none')} />
}

function Splash({ mode, onDone }: { mode: Exclude<SplashMode, 'none'>; onDone: () => void }) {
  const [skipped, setSkipped] = useState(false)
  const done = useRef(onDone)
  done.current = onDone

  // Scroll lock + safety-net timer; both are released on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const timer = window.setTimeout(() => done.current(), SPLASH_MS[mode])
    return () => { document.body.style.overflow = prev; window.clearTimeout(timer) }
  }, [mode])
  useEffect(() => {
    if (!skipped) return
    const timer = window.setTimeout(() => done.current(), 260)
    return () => window.clearTimeout(timer)
  }, [skipped])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSkipped(true) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const cls = `splash splash-${mode}${skipped ? ' skipped' : ''}`
  return (
    <div className={cls} data-testid="splash" onAnimationEnd={e => { if (e.animationName === 'sp-out' && e.target === e.currentTarget) done.current() }}>
      <svg className="splash-svg" role="img" aria-label="VYBE" viewBox={`${BOUNDS.x - 30} -30 ${BOUNDS.w + 60} ${BOUNDS.h + 60}`} fillRule="evenodd">
        <defs><filter id="sp-blur" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="22" /></filter></defs>
        {/* the single light pulse: a blurred copy of the finished wordmark, faded in and out once */}
        <g className="sp-glow" filter="url(#sp-blur)" aria-hidden="true">
          {LETTERS.map(l => <path key={l.id} d={l.d} transform={`translate(${l.x} 0)`} />)}
        </g>
        {LETTERS.map((l, i) => (
          <g key={l.id} transform={`translate(${l.x} 0)`}>
            <g className={i === 0 ? 'sp-v' : 'sp-ybe'} style={{ '--from': `${i === 0 ? V_FROM : YBE_FROM}px`, '--i': i - 1 } as React.CSSProperties}>
              <path className="sp-path" d={l.d} pathLength={1} />
            </g>
          </g>
        ))}
      </svg>
      <p className="splash-tag">{TAGLINE}</p>
      <button className="splash-skip" onClick={() => setSkipped(true)}>Skip</button>
    </div>
  )
}
