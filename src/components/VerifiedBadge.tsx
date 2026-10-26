import { BadgeCheck } from 'lucide-react'
import { isVerified } from '../lib/social'
import type { PublicProfile } from '../lib/types'

/** Blue tick shown only while a paid VYBE Verified period is active (verified_until in the future). */
export function VerifiedBadge({ profile, size = 16 }: { profile?: Pick<PublicProfile, 'verified_until'> | null; size?: number }) {
  if (!isVerified(profile)) return null
  return <BadgeCheck className="vbadge" size={size} fill="#1d9bf0" color="#fff" strokeWidth={2} role="img" aria-label="VYBE Verified" />
}

/**
 * A name with its tick on one line. The name shortens with "…" only when it truly does not fit, and the tick (and anything
 * placed after this, like a Follow button) always stays visible beside it, however long the name is.
 */
export function NameTick({ name, profile, size = 16 }: { name: string; profile?: Pick<PublicProfile, 'verified_until'> | null; size?: number }) {
  return <span className="nt"><span className="nt-t">{name}</span><VerifiedBadge profile={profile} size={size} /></span>
}
