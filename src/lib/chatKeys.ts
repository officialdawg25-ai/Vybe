import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from '../auth/AuthProvider'
import { callFunction } from './functions'
import { BACKUP_ITERATIONS, b64, backupIdentity, backupWithRecoveryKey, conversationKey, e2eeSupported, generateIdentity, keyFingerprint, lock, newRecoveryKey, publicFromPkcs8, restoreIdentity, restoreWithRecoveryKey, unb64, type Backup, type RecoveryBackup } from './e2ee'

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
/** All key changes go through audited, rate-limited database functions (and alert the owner); the tables accept no direct writes. */
async function publish(publicKey: string, backup: Backup, recovery: RecoveryBackup) {
  const { error } = await supabase.rpc('publish_chat_key', { p_public: publicKey, p_backup: backup, p_recovery: recovery })
  if (error) throw error
}

export const MIN_PASSPHRASE = 10
export type KeyState = 'loading' | 'setup' | 'restore' | 'ready' | 'unsupported'
export interface ChatKeys {
  state: KeyState
  /** My published public key (when ready). */
  publicKey: string | null
  privateKey: CryptoKey | null
  /** Creates a new identity protected by this passphrase (also used to start over). Returns the recovery key, shown to the member once. */
  setup: (passphrase: string) => Promise<string>
  /** Restores the identity from the passphrase-encrypted backup. */
  restore: (passphrase: string) => Promise<void>
  /** Restores the identity with the recovery key instead, then protects it with a new passphrase. */
  restoreWithRecovery: (recoveryKey: string, newPassphrase: string) => Promise<string>
  /** Finishes a VYBE-assisted recovery (after the waiting period): imports the released key and sets a new passphrase. Returns a fresh recovery key. */
  finishVybeRecovery: (requestId: string, password: string, newPassphrase: string) => Promise<string>
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

  const adopt = useCallback(async (uidNow: string, privateKey: CryptoKey, publicKey: string) => { await saveLocal(uidNow, { privateKey, publicKey }); setVersion(v => v + 1); notify() }, [])
  const setup = useCallback(async (passphrase: string) => {
    if (!uid) throw new Error('Sign in first.')
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`)
    const id = await generateIdentity(), recoveryKey = newRecoveryKey()
    await publish(id.publicKey, await backupIdentity(id.pkcs8, passphrase, BACKUP_ITERATIONS), await backupWithRecoveryKey(id.pkcs8, recoveryKey))
    await adopt(uid, id.privateKey, id.publicKey)
    return recoveryKey
  }, [uid, adopt])
  const restore = useCallback(async (passphrase: string) => {
    if (!uid) throw new Error('Sign in first.')
    const backup = await ownBackup(uid)
    if (!backup.backup) throw new Error('There is no backup to restore. Start over to create new keys.')
    const { privateKey, pkcs8 } = await restoreIdentity(backup.backup, passphrase)
    const publicKey = await publicFromPkcs8(pkcs8)
    if (publicKey !== (await myServerKey(uid))) throw new Error('This backup does not match your current chat key. Start over to create new keys.')
    await adopt(uid, privateKey, publicKey)
  }, [uid, adopt])
  const reprotect = useCallback(async (pkcs8: Uint8Array, newPassphrase: string) => {
    if (newPassphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`)
    const recoveryKey = newRecoveryKey()
    const { error } = await supabase.rpc('update_chat_backups', { p_backup: await backupIdentity(pkcs8, newPassphrase, BACKUP_ITERATIONS), p_recovery: await backupWithRecoveryKey(pkcs8, recoveryKey) })
    if (error) throw error
    return recoveryKey
  }, [])
  const restoreWithRecovery = useCallback(async (recoveryKey: string, newPassphrase: string) => {
    if (!uid) throw new Error('Sign in first.')
    const backup = await ownBackup(uid)
    if (!backup.recovery) throw new Error('This account has no recovery key on file.')
    const { privateKey, pkcs8 } = await restoreWithRecoveryKey(backup.recovery, recoveryKey)
    const publicKey = await publicFromPkcs8(pkcs8)
    if (publicKey !== (await myServerKey(uid))) throw new Error('This recovery key does not match your current chat key.')
    const next = await reprotect(pkcs8, newPassphrase)                       // a forgotten passphrase is replaced right away
    await adopt(uid, privateKey, publicKey)
    return next
  }, [uid, adopt, reprotect])
  const finishVybeRecovery = useCallback(async (requestId: string, password: string, newPassphrase: string) => {
    if (!uid) throw new Error('Sign in first.')
    if (newPassphrase.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`)
    const out = await callFunction<{ pkcs8: string }>('chat-recovery', { action: 'complete', id: requestId, password })
    const pkcs8 = unb64(out.pkcs8)
    const publicKey = await publicFromPkcs8(pkcs8)
    if (publicKey !== (await myServerKey(uid))) throw new Error('The recovered key does not match your published key, so it was not used.')
    const next = await reprotect(pkcs8, newPassphrase)
    await adopt(uid, await lock(pkcs8), publicKey)
    pkcs8.fill(0)
    return next
  }, [uid, adopt, reprotect])

  const key = state === 'ready' && current?.uid === uid ? current.key : null
  return { state, publicKey: key?.publicKey ?? null, privateKey: key?.privateKey ?? null, setup, restore, restoreWithRecovery, finishVybeRecovery, version }
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


/* ---------------------------------------------------------------- recovery and security settings */
interface BackupRow { backup: Backup | null; recovery: RecoveryBackup | null; escrow: boolean }
async function ownBackup(uid: string): Promise<BackupRow> {
  const { data, error } = await supabase.from('chat_key_backups').select('backup,recovery,escrow').eq('user_id', uid).maybeSingle()
  if (error) throw error
  const r = data as BackupRow | null
  return { backup: r?.backup ?? null, recovery: r?.recovery ?? null, escrow: Boolean(r?.escrow) }
}
export interface RecoveryRequest { id: string; status: 'waiting' | 'completed' | 'cancelled' | 'expired'; created_at: string; ready_at: string; expires_at: string }
export interface SecurityEvent { id: string; action: string; created_at: string; detail: Record<string, unknown> }
export interface SecurityInfo { escrow: boolean; hasRecoveryKey: boolean; request: RecoveryRequest | null; events: SecurityEvent[] }
export async function securityInfo(uid: string): Promise<SecurityInfo> {
  await supabase.rpc('expire_recovery_requests')
  const [b, req, ev] = await Promise.all([
    ownBackup(uid),
    supabase.from('chat_recovery_requests').select('id,status,created_at,ready_at,expires_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(1),
    supabase.from('chat_key_events').select('id,action,created_at,detail').eq('user_id', uid).order('created_at', { ascending: false }).limit(20),
  ])
  return { escrow: b.escrow, hasRecoveryKey: Boolean(b.recovery), request: ((req.data ?? [])[0] as RecoveryRequest | undefined) ?? null, events: (ev.data ?? []) as SecurityEvent[] }
}
export const refreshChatKeys = () => notify()

/** Opens the passphrase backup to get the raw key. Only used for actions that must re-wrap it; the bytes live in memory for a moment. */
async function unlockPkcs8(uid: string, passphrase: string): Promise<Uint8Array> {
  const { backup } = await ownBackup(uid)
  if (!backup) throw new Error('There is no backup on file.')
  return (await restoreIdentity(backup, passphrase)).pkcs8
}
/** Replace the passphrase (needs the current one) and issue a new recovery key. */
export async function changePassphrase(uid: string, current: string, next: string): Promise<string> {
  if (next.length < MIN_PASSPHRASE) throw new Error(`Use at least ${MIN_PASSPHRASE} characters.`)
  const pkcs8 = await unlockPkcs8(uid, current), recoveryKey = newRecoveryKey()
  const { error } = await supabase.rpc('update_chat_backups', { p_backup: await backupIdentity(pkcs8, next, BACKUP_ITERATIONS), p_recovery: await backupWithRecoveryKey(pkcs8, recoveryKey) })
  pkcs8.fill(0)
  if (error) throw error
  return recoveryKey
}
/** Issue a brand-new recovery key (the old one stops working). Needs the passphrase. */
export async function newRecoveryKeyFor(uid: string, passphrase: string): Promise<string> {
  const pkcs8 = await unlockPkcs8(uid, passphrase), recoveryKey = newRecoveryKey()
  const { error } = await supabase.rpc('update_chat_backups', { p_recovery: await backupWithRecoveryKey(pkcs8, recoveryKey) })
  pkcs8.fill(0)
  if (error) throw error
  return recoveryKey
}
export async function escrowAvailable(): Promise<boolean> {
  try { return Boolean((await callFunction<{ available: boolean }>('chat-recovery', { action: 'available' })).available) } catch { return false }
}
export async function enableEscrow(uid: string, passphrase: string) {
  const pkcs8 = await unlockPkcs8(uid, passphrase)
  try { await callFunction('chat-recovery', { action: 'enable', pkcs8: b64(pkcs8) }) } finally { pkcs8.fill(0) }
}
export const disableEscrow = () => callFunction('chat-recovery', { action: 'disable' })
export const requestVybeRecovery = (password: string) => callFunction<{ id: string; ready_at: string }>('chat-recovery', { action: 'request', password })
export async function cancelRecovery(id: string) {
  const { error } = await supabase.rpc('cancel_recovery_request', { p_id: id })
  if (error) throw error
}
