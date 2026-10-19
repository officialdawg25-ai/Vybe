import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useSubmit } from '../lib/hooks'
import { errMsg, toast } from '../ui'
import type { Rel } from '../lib/friends'

export function FriendButton({ other, rel, onChanged }: { other: string; rel?: Rel; onChanged: () => void }) {
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
  if (rel.status === 'accepted') return <button className="btn sm" disabled={busy} onClick={() => confirm('Remove this friend?') && act(() => del(rel.id))}>Friends</button>
  if (rel.outgoing) return <button className="btn sm" disabled={busy} onClick={() => act(() => del(rel.id))}>Requested · Cancel</button>
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn primary sm" disabled={busy} onClick={() => act(() => supabase.from('friendships').update({ status: 'accepted' }).eq('id', rel.id), 'You are now friends')}>Accept</button>
      <button className="btn sm" disabled={busy} onClick={() => act(() => del(rel.id))}>Decline</button>
    </span>
  )
}
