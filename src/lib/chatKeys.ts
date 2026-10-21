import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../auth/AuthProvider'
import { BACKUP_ITERATIONS, backupIdentity, conversationKey, e2eeSupported, generateIdentity, keyFingerprint, publicFromPkcs8, restoreIdentity, type Backup } from './e2ee'

/* ---------------------------------------------------------------- this device's key store (IndexedDB, non-extractable keys) */
interface Stored { privateKey: CryptoKey; publicKey: string }
const DB = 'vybe-e2ee', STORE = 'keys'
const open = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open(DB, 1)
  r.onupgradeneeded = () => r.result.createObjectStore(STORE)
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
})
async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((res, rej) => { const r = f(db.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => { res(r.result); db.close() }; r.onerror = () => { rej(r.error); db.close() } })
}
export const loadLocal = (uid: string) => idb<Stored | undefined>('readonly', s => s.get(uid))
const saveLocal = (uid: string, v: Stored) => idb('readwrite', s => s.put(v, uid))
export const clearLocal = (uid: string) => idb('readwrite', s => s.delete(uid))

/* ---------------------------------------------------------------- server side: public key + passphrase-encrypted backup */
async function myServerKey(uid: string): Promise<string | null> {
  const { data, error } = await supabase.from('chat_keys').select('public_key').eq('user_id', uid).maybeSingle()
  if (error) throw error
  return (data as { public_key: string } | null)?.public_key ?? null
}
export async function peerPublicKey(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('chat_keys').select('public_key').eq('user_id', userId).maybeSingle()
  if (error) { if (/chat_keys|relation|schema cache/i.test(error.message)) return null; throw error }   // before the migration there are no keys
  return (data as { public_key: string } | null)?.public_key ?? null
}
export async function peerPublicKeys(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  const { data, error } = await supabase.from('chat_keys').select('user_id,public_key').in('user_id', ids)
  if (error) return out
  for (const r of (data ?? []) as { user_id: string; public_key: string }[]) out.set(r.user_id, r.public_key)
  return out
}
type Db = Pick<typeof supabase, 'from'>
/**
 * Publishes my public key and its passphrase-encrypted backup.
 * chat_keys grants UPDATE only on (public_key, updated_at), and PostgREST's upsert also SETs user_id, which Postgres refuses
 * ("permission denied for table chat_keys") — that made "Turn on secure chat" fail for everyone. So: update my row, insert only
 * when there is none, and update again if another tab inserted first. The backup goes first: if publishing the key then fails,
 * the old key (if any) stays in place and this device simply asks again.
 */
export async function publishKeys(db: Db, uid: string, publicKey: string, backup: Backup) {
  const now = new Date().toISOString()
  const b = await db.from('chat_key_backups').upsert({ user_id: uid, backup, updated_at: now }, { onConflict: 'user_id' })
  if (b.error) throw b.error
  const update = () => db.from('chat_keys').update({ public_key: publicKey, updated_at: now }).eq('user_id', uid).select('user_id')
  const u = await update()
  if (u.error) throw u.error
  if (u.data?.length) return
  const i = await db.from('chat_keys').insert({ user_id: uid, public_key: publicKey, updated_at: now })
  if (!i.error) return
  if (i.error.code !== '23505') throw i.error
  const again = await update()
  if (again.error) throw again.error
}

export const MIN_PASSPHRASE = 10
export type KeyState = 'loading' | 'setup' | 'restore' | 'ready' | 'unsupported'
export interface ChatKeys {
  state: KeyState
  /** My published public key (when ready). */
  publicKey: string | null
  privateKey: CryptoKey | null
  /** Creates a new identity protected by this passphrase (also used to start over after a forgotten passphrase). */
  setup: (passphrase: string) => Promise<void>
  /** Restores the identity from the passphrase-encrypted backup. */
  restore: (passphrase: string) => Promise<void>
  version: number
}

// Shared across components so every screen sees the same unlocked identity.
let current: { uid: string; key: Stored } | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(f => f())

/** Works out whether this device can already read/send encrypted chats, or needs the member to set up / restore keys. */
export function useChatKeys(): ChatKeys {
  const { uid } = useAuth()
  const [state, setState] = useState<KeyState>('loading')
  const [version, setVersion] = useState(0)
  const refresh = useCallback(async () => {
    if (!uid) return
    if (!e2eeSupported()) return setState('unsupported')
    try {
      const [local, server] = await Promise.all([loadLocal(uid).catch(() => undefined), myServerKey(uid).catch(() => 'error' as const)])
      if (server === 'error') return setState('unsupported')                      // migration not applied yet or offline: standard chat
      if (local && server && local.publicKey === server) { current = { uid, key: local }; return setState('ready') }
      current = null
      // A key exists on the server that this device does not hold (new phone, cleared browser or reset elsewhere): restore it.
      setState(server ? 'restore' : 'setup')
    } catch { setState('unsupported') }
  }, [uid])
  useEffect(() => { setState('loading'); void refresh(); listeners.add(refresh); return () => { listeners.delete(refresh) } }, [refresh])

  const setup = useCallback(async (passphrase: string) => {
    if (!uid) throw new Error('Sign in first.')
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`)
    const id = await generateIdentity()
    const backup = await backupIdentity(id.pkcs8, passphrase, BACKUP_ITERATIONS)
    // Keep the private key on this device before the public key goes live, so this device can always read what is sent to it.
    await saveLocal(uid, { privateKey: id.privateKey, publicKey: id.publicKey })
    await publishKeys(supabase, uid, id.publicKey, backup)
    setVersion(v => v + 1); notify()
  }, [uid])
  const restore = useCallback(async (passphrase: string) => {
    if (!uid) throw new Error('Sign in first.')
    const { data, error } = await supabase.from('chat_key_backups').select('backup').eq('user_id', uid).maybeSingle()
    if (error) throw error
    const backup = (data as { backup: Backup } | null)?.backup
    if (!backup) throw new Error('There is no backup to restore. Start over to create new keys.')
    const { privateKey, pkcs8 } = await restoreIdentity(backup, passphrase)
    const publicKey = await publicFromPkcs8(pkcs8)
    if (publicKey !== (await myServerKey(uid))) throw new Error('This backup does not match your current chat key. Start over to create new keys.')
    await saveLocal(uid, { privateKey, publicKey })
    setVersion(v => v + 1); notify()
  }, [uid])

  const key = state === 'ready' && current?.uid === uid ? current.key : null
  return { state, publicKey: key?.publicKey ?? null, privateKey: key?.privateKey ?? null, setup, restore, version }
}

/* ---------------------------------------------------------------- per-conversation keys and "has this contact's key changed?" */
const convKeys = new Map<string, Promise<CryptoKey>>()
export function getConversationKey(privateKey: CryptoKey, myPublic: string, theirPublic: string, conversationId: string, myId: string, theirId: string) {
  const id = `${conversationId}|${myPublic}|${theirPublic}`
  let p = convKeys.get(id)
  if (!p) { p = conversationKey(privateKey, theirPublic, conversationId, myId, theirId); convKeys.set(id, p) }
  return p
}

const seenKey = (uid: string, peer: string) => `vybe:peerkey:${uid}:${peer}`
/** Trust on first use: remember a contact's key; report when it later changes so the member can re-verify. */
export async function checkPeerKey(uid: string, peer: string, pub: string): Promise<'new' | 'same' | 'changed'> {
  const fp = await keyFingerprint(pub)
  try {
    const prev = localStorage.getItem(seenKey(uid, peer))
    if (!prev) { localStorage.setItem(seenKey(uid, peer), fp); return 'new' }
    return prev === fp ? 'same' : 'changed'
  } catch { return 'same' }
}
export async function acceptPeerKey(uid: string, peer: string, pub: string) { try { localStorage.setItem(seenKey(uid, peer), await keyFingerprint(pub)) } catch { /* private mode */ } }
