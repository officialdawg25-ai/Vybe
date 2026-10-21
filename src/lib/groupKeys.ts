import { supabase } from './supabase'
import { peerPublicKeys } from './chatKeys'
import { newGroupKey, groupMessageKey, unwrapGroupKey, wrapGroupKey } from './e2ee'

export interface HeldKey { raw: Uint8Array; key: CryptoKey }
export interface LoadedKeys { held: Map<number, HeldKey>; /** epochs whose delivered copy could not be opened (corrupted or sealed wrongly) */ bad: number[] }

/** Opens every group key that has been delivered to this member (each one is sealed for their public key and can only be opened with their private key). */
export async function loadGroupKeys(conversationId: string, uid: string, privateKey: CryptoKey): Promise<LoadedKeys> {
  const { data, error } = await supabase.from('conversation_keys').select('epoch,wrapped,wrapped_by').eq('conversation_id', conversationId)
  if (error) throw error
  const rows = (data ?? []) as { epoch: number; wrapped: string; wrapped_by: string }[]
  const pubs = await peerPublicKeys([...new Set(rows.map(r => r.wrapped_by))])
  const held = new Map<number, HeldKey>(), bad: number[] = []
  for (const r of rows) {
    const pub = pubs.get(r.wrapped_by)
    try { if (!pub) throw new Error('unknown sender'); held.set(r.epoch, await unwrapGroupKey(privateKey, pub, r.wrapped, conversationId, r.epoch, uid)) } catch { bad.push(r.epoch) }
  }
  return { held, bad }
}

/** Seals the group key for every member who has a published key but no copy yet. Anyone who holds the key can do this for newcomers. */
export async function distributeGroupKey(conversationId: string, uid: string, privateKey: CryptoKey, epoch: number, raw: Uint8Array): Promise<number> {
  const { data, error } = await supabase.rpc('group_key_status', { p_conversation: conversationId, p_epoch: epoch })
  if (error) throw error
  const need = (Array.isArray(data) ? data : []) as { user_id: string; public_key: string }[]
  if (!need.length) return 0
  const rows = await Promise.all(need.map(async m => ({ conversation_id: conversationId, user_id: m.user_id, epoch, wrapped: await wrapGroupKey(privateKey, m.public_key, raw, conversationId, epoch, m.user_id), wrapped_by: uid })))
  const ins = await supabase.from('conversation_keys').upsert(rows, { onConflict: 'conversation_id,user_id,epoch', ignoreDuplicates: true })
  if (ins.error) throw ins.error
  return rows.length
}

/**
 * Turns encryption on for a group. The database says whether this call started the epoch; only the starter makes the key and delivers it
 * (to everyone who can already receive it). Others get theirs from whoever holds it.
 */
export async function startGroupEncryption(conversationId: string, uid: string, privateKey: CryptoKey): Promise<{ epoch: number; key: HeldKey | null }> {
  const { data, error } = await supabase.rpc('start_group_encryption', { p_conversation: conversationId })
  if (error) throw error
  const r = (data ?? {}) as { epoch?: number; created?: boolean }
  const epoch = Number(r.epoch) || 1
  if (!r.created) return { epoch, key: null }
  const raw = newGroupKey()
  await distributeGroupKey(conversationId, uid, privateKey, epoch, raw)
  return { epoch, key: { raw, key: await groupMessageKey(raw) } }
}

/** Removes this member's own (unusable) copy for an epoch so that a member who holds the key delivers it again. */
export async function dropOwnKey(conversationId: string, uid: string, epoch: number) {
  await supabase.from('conversation_keys').delete().eq('conversation_id', conversationId).eq('user_id', uid).eq('epoch', epoch)
}
