import { useEffect, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { setFollow, type FollowType } from '../../lib/discover'
import { playSound } from '../../lib/sounds'
import { errMsg, toast } from '../../ui'

/** Follow / Following. Optimistic, but the persisted row is the truth: a failed write rolls the button back and says why. */
export function FollowButton({ type, id, following, onChange, size = 'sm', label, idleText = 'Follow', className = '' }: { type: FollowType; id: string; following: boolean; onChange?: (on: boolean) => void; size?: 'sm' | 'md'; label?: string; idleText?: string; className?: string }) {
  const { uid } = useAuth()
  const [on, setOn] = useState(following)
  const [busy, setBusy] = useState(false)
  useEffect(() => setOn(following), [following])
  if (!uid || (type === 'profile' && id === uid)) return null
  const toggle = async () => {
    if (busy) return
    const next = !on
    setBusy(true); setOn(next)
    try { await setFollow(type, id, uid, next); playSound(next ? 'like' : 'unlike'); onChange?.(next) } catch (e) { setOn(!next); toast(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <button className={`btn${size === 'sm' ? ' sm' : ''}${on ? '' : ' primary'} ${className}`.trim()} aria-pressed={on} aria-label={`${on ? 'Unfollow' : idleText}${label ? ` ${label}` : ''}`} disabled={busy} onClick={toggle}>
      {on ? <><Check size={16} aria-hidden /> Following</> : <><Plus size={16} aria-hidden /> {idleText}</>}
    </button>
  )
}
