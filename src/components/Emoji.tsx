import { useMemo } from 'react'
import { REACTIONS, type ReactionKey } from '../lib/social'

/**
 * Animated reaction emoji. Each reaction has its own motion (a heart that beats, a laugh that wobbles, a flame that
 * flickers…) done in CSS on the device's native emoji, so there is nothing to download and it works offline.
 * `idle` loops the motion (use it for a reaction you have selected), `pop` plays the entrance once, and
 * `prefers-reduced-motion` turns all of it off.
 */
export function Emoji({ k, size, idle, pop, label }: { k: ReactionKey | string; size?: number | string; idle?: boolean; pop?: boolean; label?: string }) {
  const r = REACTIONS.find(x => x.key === k)
  const glyph = r?.emoji ?? String(k)
  return (
    <span className={`emo emo-${r?.key ?? 'x'}${idle ? ' idle' : ''}${pop ? ' pop' : ''}`} style={size ? { fontSize: size } : undefined} role="img" aria-label={label ?? r?.label ?? 'Emoji'}>{glyph}</span>
  )
}

/** Particles that float up from a reaction when it is sent. Remount with a new `n` to replay. */
export function Burst({ k, n, count = 7 }: { k: ReactionKey | string; n: number; count?: number }) {
  const glyph = REACTIONS.find(x => x.key === k)?.emoji ?? String(k)
  const parts = useMemo(() => Array.from({ length: count }, (_, i) => {
    const a = (-80 + (160 / Math.max(count - 1, 1)) * i) * (Math.PI / 180)    // fan upward
    const d = 56 + ((i * 37) % 40)
    return { dx: Math.round(Math.sin(a) * d), dy: -Math.round(Math.cos(a) * d) - 24, delay: (i % 4) * 40, scale: 0.7 + ((i * 13) % 6) / 10 }
  }), [count, n]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!n) return null
  return (
    <span className="emo-burst" key={n} aria-hidden>
      {parts.map((p, i) => <i key={i} style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--dl': `${p.delay}ms`, '--sc': p.scale } as React.CSSProperties}>{glyph}</i>)}
    </span>
  )
}
