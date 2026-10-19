import { WORDMARK } from './logoPaths'

/** Official VYBE purple, sampled from the supplied wordmark. Kept as one token (`--logo`) in styles.css. */
export const LOGO_COLOR = '#9366a9'

const [V, ...REST] = WORDMARK.letters
export const LETTERS = WORDMARK.letters
/** Wordmark bounds: the traced letters start at x = V.x, so the viewBox is trimmed to the artwork. */
export const BOUNDS = { x: V.x, w: WORDMARK.width - V.x, h: WORDMARK.height }

export type LogoTone = 'brand' | 'light' | 'dark'
const FILL: Record<LogoTone, string> = { brand: 'var(--logo, #9366a9)', light: '#ffffff', dark: '#15151c' }

/** The full VYBE wordmark. `tone`: brand purple, white (on imagery / dark art) or near-black (on light art). */
export function Wordmark({ height = 24, tone = 'brand', className }: { height?: number; tone?: LogoTone; className?: string }) {
  return (
    <svg className={className} role="img" aria-label="VYBE" viewBox={`${BOUNDS.x} 0 ${BOUNDS.w} ${BOUNDS.h}`}
      width={(height * BOUNDS.w) / BOUNDS.h} height={height} fill={FILL[tone]} fillRule="evenodd" focusable="false">
      {LETTERS.map(l => <path key={l.id} d={l.d} transform={`translate(${l.x} 0)`} />)}
    </svg>
  )
}

/** The standalone V, used where the full wordmark would not fit (favicon, compact marks). */
export function VMark({ size = 24, tone = 'brand', className }: { size?: number; tone?: LogoTone; className?: string }) {
  return (
    <svg className={className} role="img" aria-label="VYBE" viewBox={`0 0 ${V.w} ${BOUNDS.h}`}
      width={(size * V.w) / BOUNDS.h} height={size} fill={FILL[tone]} fillRule="evenodd" focusable="false">
      <path d={V.d} />
    </svg>
  )
}

export { V, REST }
