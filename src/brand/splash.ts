/** Decides whether (and how) the VYBE entrance animation plays. Pure, so it can be unit-tested. */
export type SplashMode = 'full' | 'short' | 'reduced' | 'none'

export interface SplashInput {
  path: string
  /** The splash has played in this browser before (localStorage). */
  seenEver: boolean
  /** The splash has already played in this tab/session (sessionStorage). */
  seenThisSession: boolean
  /** The user was signed in last time (localStorage hint kept by SplashGate). */
  signedInHint: boolean
  reducedMotion: boolean
}

export function splashMode(i: SplashInput): SplashMode {
  // Only the public entry route ever shows it: deep links, auth redirects and expired sessions are never delayed.
  if (i.path !== '/') return 'none'
  if (i.seenThisSession) return 'none'
  if (i.seenEver && i.signedInHint) return 'none'
  if (i.reducedMotion) return 'reduced'
  return i.seenEver ? 'short' : 'full'
}

/** Fired by the sign-in page after a successful password sign-in so the entrance plays every time someone logs in. */
export const LOGIN_EVENT = 'vybe:login'
export const SEEN_KEY = 'vybe:splash:v1'
export const HINT_KEY = 'vybe:signed-in'

const safe = <T,>(f: () => T, fallback: T): T => { try { return f() } catch { return fallback } }

export function readSplashInput(path: string): SplashInput {
  return {
    path,
    seenEver: safe(() => localStorage.getItem(SEEN_KEY) === '1', false),
    seenThisSession: safe(() => sessionStorage.getItem(SEEN_KEY) === '1', false),
    signedInHint: safe(() => localStorage.getItem(HINT_KEY) === '1', false),
    reducedMotion: safe(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, false),
  }
}
export const markSplashSeen = () => safe(() => { localStorage.setItem(SEEN_KEY, '1'); sessionStorage.setItem(SEEN_KEY, '1') }, undefined)
export const setSignedInHint = (on: boolean) => safe(() => { on ? localStorage.setItem(HINT_KEY, '1') : localStorage.removeItem(HINT_KEY) }, undefined)

/** Total length (ms) of each variant, used only as a safety net if the CSS `animationend` never fires. */
export const SPLASH_MS: Record<Exclude<SplashMode, 'none'>, number> = { full: 4600, short: 3000, reduced: 1400 }
