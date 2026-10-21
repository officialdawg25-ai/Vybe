import { useCallback, useEffect, useMemo, useState } from 'react'
import { acceptPeerKey, checkPeerKey, getConversationKey, peerPublicKey, type ChatKeys } from './chatKeys'
import { decryptBlob, decryptEnvelope, encryptBlob, encryptEnvelope, securityCode, type Envelope } from './e2ee'
import { supabase } from './supabase'

export type SecureStatus =
  | 'loading'          // working out which mode applies; sending waits so nothing goes out the wrong way
  | 'standard'         // group chat, or this browser/server cannot do secure chat
  | 'needs-setup'      // I have not turned on secure chat on this device
  | 'peer-missing'     // they have not turned it on yet: messages are sent the ordinary (non end-to-end) way
  | 'secure'

/** Everything a one-to-one thread needs to send and read end-to-end encrypted messages. */
export function useSecureChat(o: { conversationId: string; uid: string | null; peerId?: string; keys: ChatKeys; group: boolean; loading?: boolean }) {
  const { conversationId, uid, peerId, keys, group, loading } = o
  const [peerPub, setPeerPub] = useState<string | null | undefined>(undefined)       // undefined = still loading
  const [change, setChange] = useState<'new' | 'same' | 'changed'>('same')
  const [code, setCode] = useState('')

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

  const status: SecureStatus = loading || (!group && peerId && (keys.state === 'loading' || peerPub === undefined)) ? 'loading'
    : group || !peerId || keys.state === 'unsupported' ? 'standard'
    : keys.state !== 'ready' ? 'needs-setup' : peerPub ? 'secure' : 'peer-missing'
  // While a change of the contact's key is unacknowledged, sending is paused (reading old messages still works).
  const blocked = status === 'secure' && change === 'changed'

  const key = useMemo(() => (status === 'secure' && uid && peerId && keys.privateKey && keys.publicKey && peerPub
    ? getConversationKey(keys.privateKey, keys.publicKey, peerPub, conversationId, uid, peerId) : null), [status, uid, peerId, keys.privateKey, keys.publicKey, peerPub, conversationId])

  const encrypt = useCallback(async (env: Envelope): Promise<string> => { if (!key || !uid) throw new Error('Secure chat is not ready.'); return encryptEnvelope(await key, env, conversationId, uid) }, [key, uid, conversationId])
  const decrypt = useCallback(async (body: string, sender: string): Promise<Envelope | 'locked'> => {
    if (!key) return 'locked'
    try { return await decryptEnvelope(await key, body, conversationId, sender) } catch { return 'locked' }
  }, [key, conversationId])
  const accept = useCallback(async () => { if (uid && peerId && peerPub) { await acceptPeerKey(uid, peerId, peerPub); setChange('same') } }, [uid, peerId, peerPub])
  return { status, blocked, change, code, peerPub, ready: Boolean(key), encrypt, decrypt, accept }
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
export async function uploadEncrypted(uid: string, data: ArrayBuffer): Promise<{ path: string; key: string; iv: string; size: number }> {
  const { cipher, key, iv } = await encryptBlob(data)
  const path = `${uid}/${crypto.randomUUID()}.enc`
  const { error } = await supabase.storage.from('attachments').upload(path, cipher, { contentType: 'application/octet-stream', upsert: false, cacheControl: '3600' })
  if (error) throw new Error(/exceeded|too large|maximum/i.test(error.message) ? 'That file is larger than your storage upload limit.' : error.message)
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
