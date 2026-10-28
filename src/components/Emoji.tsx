import { REACTIONS, type ReactionKey } from '../lib/social'

/**
 * Reaction emoji: the device's own emoji, drawn plainly and still. The only motion is a short, soft settle when a reaction
 * is chosen (`pop`); there are no loops or particles, and `prefers-reduced-motion` turns even that off.
 */
export function Emoji({ k, size, pop, label }: { k: ReactionKey | string; size?: number | string; idle?: boolean; pop?: boolean; label?: string }) {
  const r = REACTIONS.find(x => x.key === k)
  const cls = `emo emo-${r?.key ?? 'x'}${pop ? ' pop' : ''}`, st = size ? { fontSize: size } : undefined
  if (label === '') return <span className={cls} style={st} aria-hidden>{r?.emoji ?? String(k)}</span>     // decorative: a visible word already names it
  return <span className={cls} style={st} role="img" aria-label={label ?? r?.label ?? 'Emoji'}>{r?.emoji ?? String(k)}</span>
}

/** Kept so existing callers compile; reactions no longer throw particles. */
export function Burst(_props: { k: ReactionKey | string; n: number; count?: number }) { return null }
