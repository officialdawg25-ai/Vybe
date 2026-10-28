import { useState } from 'react'
import { UserMinus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { ConfirmSheet } from './ConfirmSheet'
import { useAuth } from '../auth/AuthProvider'
import { useSubmit } from '../lib/hooks'
import { errMsg, toast } from '../ui'
import type { Rel } from '../lib/friends'

export function FriendButton({ other, rel, onChanged, name }: { other: string; rel?: Rel; onChanged: () => void; name?: string }) {
  const [asking, setAsking] = useState(false)
  const { uid } = useAuth()
  const [busy, submit] = useSubmit()
  const act = (fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>, ok?: string) => submit(async () => {
    const { error } = await fn()
    if (error && error.code !== '23505') return toast(errMsg(error))
    if (ok) toast(ok)
    onChanged()
  })
  const del = (id: string) => supabase.from('friendships').delete().eq('id', id)

  if (!rel) return <button className="btn primary sm" disabled={busy} onClick={() => act(() => supabase.from('friendships').insert({ requester: uid, addressee: other }), 'Friend request sent')}>Add friend</button>
  if (rel.status === 'accepted') return (
    <>
      <button className="btn sm" disabled={busy} onClick={() => setAsking(true)} aria-haspopup="dialog">Friends</button>
      {asking && <ConfirmSheet title="Unfriend" icon={<UserMinus size={26} />} lead={`Unfriend ${name ?? 'this person'}?`} confirmLabel="Unfriend" onClose={() => setAsking(false)} onConfirm={() => act(() => del(rel.id), 'Unfriended')}
        points={['You will stop seeing each other’s friends-only posts and memories.', 'They are not told. You can still follow each other and message if your settings allow.', 'You can send a new friend request any time.']} />}
    </>
  )
  if (rel.outgoing) return <button className="btn sm" disabled={busy} onClick={() => act(() => del(rel.id))}>Requested · Cancel</button>
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn primary sm" disabled={busy} onClick={() => act(() => supabase.from('friendships').update({ status: 'accepted' }).eq('id', rel.id), 'You are now friends')}>Accept</button>
      <button className="btn sm" disabled={busy} onClick={() => act(() => del(rel.id))}>Decline</button>
    </span>
  )
}
