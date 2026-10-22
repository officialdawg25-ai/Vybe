import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { acceptPeerKey, checkPeerKey, getConversationKey, peerPublicKey, type ChatKeys } from './chatKeys'
import { decryptBlob, decryptEnvelope, encryptBlob, encryptEnvelope, securityCode, type Envelope } from './e2ee'
import { distributeGroupKey, dropOwnKey, loadGroupKeys, startGroupEncryption, type HeldKey } from './groupKeys'
import { supabase } from './supabase'
import { UploadError, queued, uploadObject } from './upload'

export type SecureStatus =
  | 'loading'          // working out which mode applies; sending waits so nothing goes out the wrong way
  | 'standard'         // a plain group, or this browser/server cannot do secure chat
  | 'needs-setup'      // I have not turned on (or unlocked) secure chat on this device
  | 'peer-missing'     // one-to-one: they have not turned it on yet, so messages are sent the ordinary (non end-to-end) way
  | 'waiting-key'      // encrypted group: I am set up but nobody has delivered the group key to me yet
  | 'locked-out'       // encrypted group in a browser that cannot do secure chat: it accepts only encrypted messages
  | 'secure'

/** Everything a thread needs to send and read end-to-end encrypted messages: one-to-one (pairwise keys) and groups (a delivered group key). */
export function useSecureChat(o: { conversationId: string; uid: string | null; peerId?: string; keys: ChatKeys; group: boolean; epoch?: number; loading?: boolean }) {
  const { conversationId, uid, peerId, keys, group, loading } = o
  const epoch = o.epoch ?? 0
  const [peerPub, setPeerPub] = useState<string | null | undefined>(undefined)       // undefined = still loading
  const [change, setChange] = useState<'new' | 'same' | 'changed'>('same')
  const [code, setCode] = useState('')
  const [held, setHeld] = useState<Map<number, HeldKey>>(new Map())
  const [groupReady, setGroupReady] = useState(false)
  const [keyVersion, setKeyVersion] = useState(0)
  const dropped = useRef(new Set<number>())

  useEffect(() => {
    let live = true
    setPeerPub(undefined)
    if (!peerId || group) return
    peerPublicKey(peerId).then(k => { if (live) setPeerPub(k) }, () => { if (live) setPeerPub(null) })
    return () => { live = false }
  }, [peerId, group, keys.version])

  useEffect(() => {
    if (!uid || !peerId || !peerPub) { setChange('same'); return }
    let live = true
    checkPeerKey(uid, peerId, peerPub).then(r => { if (live) setChange(r) })
    return () => { live = false }
  }, [uid, peerId, peerPub])

  useEffect(() => {
    if (!keys.publicKey || !peerPub) { setCode(''); return }
    let live = true
    securityCode(keys.publicKey, peerPub).then(c => { if (live) setCode(c) })
    return () => { live = false }
  }, [keys.publicKey, peerPub])

  // Encrypted group: collect the keys delivered to me, repair a bad copy once, and deliver the key to members who are still waiting.
  const refreshGroup = useCallback(async () => {
    if (!group || epoch <= 0 || !uid || keys.state !== 'ready' || !keys.privateKey) return
    try {
      const loaded = await loadGroupKeys(conversationId, uid, keys.privateKey)
      for (const e of loaded.bad) if (!dropped.current.has(e)) { dropped.current.add(e); await dropOwnKey(conversationId, uid, e) }
      setHeld(prev => { const next = new Map(prev); for (const [e, k] of loaded.held) next.set(e, k); return next })
      setKeyVersion(v => v + 1)
      const mine = loaded.held.get(epoch)
      if (mine) await distributeGroupKey(conversationId, uid, keys.privateKey, epoch, mine.raw).catch(() => {})
    } catch { /* offline or not migrated: try again on the next tick */ }
    setGroupReady(true)
  }, [group, epoch, uid, keys.state, keys.privateKey, conversationId])
  useEffect(() => {
    if (!group || epoch <= 0) return
    setGroupReady(false); void refreshGroup()
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshGroup() }, 20_000)
    return () => window.clearInterval(t)
  }, [group, epoch, refreshGroup, keys.version])

  const holdsCurrent = held.has(epoch)
  const status: SecureStatus = (() => {
    if (loading) return 'loading'
    if (group) {
      if (epoch <= 0) return keys.state === 'loading' ? 'loading' : 'standard'
      if (keys.state === 'loading') return 'loading'
      if (keys.state === 'unsupported') return 'locked-out'
      if (keys.state !== 'ready') return 'needs-setup'
      if (holdsCurrent) return 'secure'
      return groupReady ? 'waiting-key' : 'loading'
    }
    if (peerId && (keys.state === 'loading' || peerPub === undefined)) return 'loading'
    if (!peerId || keys.state === 'unsupported') return 'standard'
    if (keys.state !== 'ready') return 'needs-setup'
    return peerPub ? 'secure' : 'peer-missing'
  })()
  // While a change of the contact's key is unacknowledged, sending is paused (reading old messages still works).
  const blocked = !group && status === 'secure' && change === 'changed'

  const pairKey = useMemo(() => (!group && status === 'secure' && uid && peerId && keys.privateKey && keys.publicKey && peerPub
    ? getConversationKey(keys.privateKey, keys.publicKey, peerPub, conversationId, uid, peerId) : null), [group, status, uid, peerId, keys.privateKey, keys.publicKey, peerPub, conversationId])

  /** Whether this device can open a message sent under this group epoch (always true for one-to-one when secure). */
  const hasKey = useCallback((msgEpoch?: number | null) => (group ? held.has(msgEpoch ?? epoch) : Boolean(pairKey)), [group, held, epoch, pairKey, keyVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const encrypt = useCallback(async (env: Envelope): Promise<{ body: string; epoch?: number }> => {
    if (!uid) throw new Error('Secure chat is not ready.')
    if (group) { const k = held.get(epoch); if (!k) throw new Error('This group’s key has not reached you yet.'); return { body: await encryptEnvelope(k.key, env, conversationId, uid, epoch), epoch } }
    if (!pairKey) throw new Error('Secure chat is not ready.')
    return { body: await encryptEnvelope(await pairKey, env, conversationId, uid) }
  }, [pairKey, held, group, epoch, uid, conversationId])
  const decrypt = useCallback(async (body: string, sender: string, msgEpoch?: number | null): Promise<Envelope | 'locked'> => {
    try {
      if (group) { const k = held.get(msgEpoch ?? epoch); return k ? await decryptEnvelope(k.key, body, conversationId, sender, msgEpoch ?? epoch) : 'locked' }
      return pairKey ? await decryptEnvelope(await pairKey, body, conversationId, sender) : 'locked'
    } catch { return 'locked' }
  }, [pairKey, held, group, epoch, conversationId])
  const accept = useCallback(async () => { if (uid && peerId && peerPub) { await acceptPeerKey(uid, peerId, peerPub); setChange('same') } }, [uid, peerId, peerPub])
  /** Starts encryption for this (plain) group from this device. */
  const enableGroup = useCallback(async () => {
    if (!uid || !keys.privateKey) throw new Error('Turn on secure chat first.')
    const r = await startGroupEncryption(conversationId, uid, keys.privateKey)
    if (r.key) setHeld(prev => new Map(prev).set(r.epoch, r.key!))
    setKeyVersion(v => v + 1)
    return r.epoch
  }, [uid, keys.privateKey, conversationId])
  return { status, blocked, change, code, peerPub, ready: group ? held.size > 0 : Boolean(pairKey), hasKey, keyVersion, encrypt, decrypt, accept, enableGroup, canEnableGroup: group && epoch <= 0 && keys.state === 'ready' }
}

/* ---------------------------------------------------------------- encrypted attachments */
const cache = new Map<string, Promise<string>>()
/** Downloads an encrypted attachment, decrypts it in the browser and returns a local blob URL (cached for the session). */
export function openAttachment(path: string, key: string, iv: string, mime: string): Promise<string> {
  const id = `${path}|${key}`
  let p = cache.get(id)
  if (!p) {
    p = (async () => {
      const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 600)
      if (error || !data) throw new Error('Could not open this file.')
      const res = await fetch(data.signedUrl)
      if (!res.ok) throw new Error('Could not download this file.')
      return URL.createObjectURL(await decryptBlob(await res.arrayBuffer(), key, iv, mime))
    })()
    p.catch(() => cache.delete(id))
    cache.set(id, p)
  }
  return p
}

/** Encrypts a file and uploads the ciphertext; returns the stored path and the key material for the message envelope. */
export async function uploadEncrypted(uid: string, data: ArrayBuffer, t: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {}): Promise<{ path: string; key: string; iv: string; size: number }> {
  const { cipher, key, iv } = await encryptBlob(data)
  const path = `${uid}/${crypto.randomUUID()}.enc`
  // Only ciphertext leaves the device; big files go up in resumable chunks (lib/upload.ts).
  try { await queued(() => uploadObject({ bucket: 'attachments', path, file: cipher, contentType: 'application/octet-stream', cacheControl: '3600', ...t })) }
  catch (e) { throw new Error(e instanceof UploadError && e.kind === 'too_large' ? 'That file is larger than your storage upload limit.' : (e as Error).message) }
  return { path, key, iv, size: cipher.size }
}

/** Decrypts one attachment into a blob URL as soon as it is on screen. */
export function useAttachmentUrl(path: string | null | undefined, env: { key: string; iv: string; mime: string } | null) {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false })
  useEffect(() => {
    let live = true
    setState({ url: null, failed: false })
    if (!path || !env) return
    openAttachment(path, env.key, env.iv, env.mime).then(u => { if (live) setState({ url: u, failed: false }) }, () => { if (live) setState({ url: null, failed: true }) })
    return () => { live = false }
  }, [path, env?.key, env?.iv, env?.mime]) // eslint-disable-line react-hooks/exhaustive-deps
  return state
}
