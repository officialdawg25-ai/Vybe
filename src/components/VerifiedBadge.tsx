import { BadgeCheck } from 'lucide-react'
import { isVerified } from '../lib/social'
import type { PublicProfile } from '../lib/types'

/** Blue tick shown only while a paid VYBE Verified period is active (verified_until in the future). */
export function VerifiedBadge({ profile, size = 16 }: { profile?: Pick<PublicProfile, 'verified_until'> | null; size?: number }) {
  if (!isVerified(profile)) return null
  return <BadgeCheck className="vbadge" size={size} fill="#1d9bf0" color="#fff" strokeWidth={2} role="img" aria-label="VYBE Verified" />
}
