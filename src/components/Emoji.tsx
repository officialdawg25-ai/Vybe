import { useMemo, useState } from 'react'
import { REACTIONS, type ReactionKey } from '../lib/social'

/**
 * Animated reaction emoji. The animated artwork is Google's Noto Emoji animation set (CC BY 4.0, see public/emoji/NOTICE.txt),
 * shipped with the app as small looping WebP files (about 50 KB each, loaded only when one is on screen), so there is no
 * third-party request and it works offline. Each reaction also has its own CSS motion for the moment it is chosen (`pop`).
 * People who ask for reduced motion, and any emoji without artwork, get the device's native emoji, still.
 */
const ART: Record<string, string> = {
  heart: 'heart', like: 'like', laugh: 'laugh', wow: 'wow', sad: 'sad', fire: 'fire',
  '❤️': 'heart', '❤': 'heart', '👍': 'like', '😂': 'laugh', '😮': 'wow', '😢': 'sad', '🔥': 'fire',
  '👏': 'clap', '🎉': 'party', '💯': 'hundred', '👀': 'eyes', '🙌': 'hands', '✨': 'sparkles', '😍': 'loveeyes',
}
export const hasArt = (k: string) => k in ART
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const glyphOf = (k: string) => REACTIONS.find(x => x.key === k)?.emoji ?? k

export function Emoji({ k, size, idle, pop, label }: { k: ReactionKey | string; size?: number | string; idle?: boolean; pop?: boolean; label?: string }) {
  const r = REACTIONS.find(x => x.key === k)
  const glyph = r?.emoji ?? String(k)
  const art = ART[String(k)]
  const [broken, setBroken] = useState(false)
  const px = typeof size === 'number' ? size : undefined
  const cls = `emo emo-${r?.key ?? 'x'}${idle ? ' idle' : ''}${pop ? ' pop' : ''}`
  const name = label ?? r?.label ?? 'Emoji'
  if (art && !broken && !calm()) {
    return (
      <span className={`${cls} emo-art`} style={size ? { fontSize: size, width: size, height: size } : undefined} role="img" aria-label={name}>
        <img src={`/emoji/${art}.webp`} alt="" width={px} height={px} decoding="async" draggable={false} onError={() => setBroken(true)} />
      </span>
    )
  }
  return <span className={cls} style={size ? { fontSize: size } : undefined} role="img" aria-label={name}>{glyph}</span>
}

/** Particles that float up from a reaction when it is sent. Remount with a new `n` to replay. */
export function Burst({ k, n, count = 7 }: { k: ReactionKey | string; n: number; count?: number }) {
  const glyph = glyphOf(String(k))
  const art = ART[String(k)]
  const parts = useMemo(() => Array.from({ length: count }, (_, i) => {
    const a = (-80 + (160 / Math.max(count - 1, 1)) * i) * (Math.PI / 180)    // fan upward
    const d = 56 + ((i * 37) % 40)
    return { dx: Math.round(Math.sin(a) * d), dy: -Math.round(Math.cos(a) * d) - 24, delay: (i % 4) * 40, scale: 0.7 + ((i * 13) % 6) / 10 }
  }), [count, n]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!n) return null
  return (
    <span className="emo-burst" key={n} aria-hidden>
      {parts.map((p, i) => <i key={i} style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--dl': `${p.delay}ms`, '--sc': p.scale } as React.CSSProperties}>{art && !calm() ? <img src={`/emoji/${art}.webp`} alt="" width={28} height={28} decoding="async" draggable={false} /> : glyph}</i>)}
    </span>
  )
}
