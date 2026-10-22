/**
 * End-to-end encryption primitives for one-to-one chat, built only on the browser's WebCrypto (no third-party crypto code).
 *
 *  - Identity: an ECDH P-256 key pair per member. The public key is published; the private key never leaves the device except as
 *    a backup encrypted with the member's chat passphrase (PBKDF2-SHA-256, 600 000 rounds → AES-256-GCM).
 *  - Conversation key: ECDH(my private, their public) → HKDF-SHA-256 bound to the conversation and both member ids → AES-256-GCM.
 *  - Every message is AES-GCM with a fresh random 96-bit IV; the conversation id and sender id are authenticated (AAD), so a
 *    ciphertext cannot be replayed into another conversation or attributed to someone else.
 *  - Files, photos, videos and voice notes are encrypted with a fresh random key each; that key travels inside the encrypted message.
 *
 * What this does NOT hide: who talks to whom, when, message sizes, and (for attachments) the file's size and the voice-note length.
 */

const te = new TextEncoder(), td = new TextDecoder()
const subtle = () => { const s = globalThis.crypto?.subtle; if (!s) throw new Error('This browser cannot do secure chat.'); return s }
export const e2eeSupported = () => typeof globalThis.crypto?.subtle?.deriveBits === 'function' && typeof indexedDB !== 'undefined'

export const b64 = (u: Uint8Array): string => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) }
export const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

export const PREFIX = 'e2ee1.'
export const isCiphertext = (body: string | null | undefined) => typeof body === 'string' && body.startsWith(PREFIX)

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

export interface Backup { v: 1; salt: string; iv: string; ct: string; iter: number }
export const BACKUP_ITERATIONS = 600_000

/** A new identity. The private key is returned extractable only so it can be backed up once; store it with `lock()`. */
export async function generateIdentity(): Promise<{ privateKey: CryptoKey; publicKey: string; pkcs8: Uint8Array }> {
  const pair = await subtle().generateKey(CURVE, true, ['deriveBits'])
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))
  const publicKey = b64(new Uint8Array(await subtle().exportKey('raw', pair.publicKey)))
  return { privateKey: await lock(pkcs8), publicKey, pkcs8 }
}
/** Imports a private key as non-extractable, so scripts on the page can use it but never read it out. */
export const lock = (pkcs8: Uint8Array) => subtle().importKey('pkcs8', buf(pkcs8), CURVE, false, ['deriveBits'])
export const importPublic = (b: string) => subtle().importKey('raw', buf(unb64(b)), CURVE, false, [])

const passKey = async (pass: string, salt: Uint8Array, iter: number) =>
  subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: iter }, await subtle().importKey('raw', buf(te.encode(pass.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

export async function backupIdentity(pkcs8: Uint8Array, pass: string, iter = BACKUP_ITERATIONS): Promise<Backup> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(te.encode('vybe-key-backup-v1')) }, await passKey(pass, salt, iter), buf(pkcs8)))
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct), iter }
}
/** Throws when the passphrase is wrong (the authentication tag fails). */
export async function restoreIdentity(backup: Backup, pass: string): Promise<{ privateKey: CryptoKey; pkcs8: Uint8Array }> {
  if (backup.v !== 1 || !(backup.iter >= 100_000 && backup.iter <= 5_000_000)) throw new Error('Unsupported backup')
  try {
    const pkcs8 = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(backup.iv)), additionalData: buf(te.encode('vybe-key-backup-v1')) }, await passKey(pass, unb64(backup.salt), backup.iter), buf(unb64(backup.ct))))
    return { privateKey: await lock(pkcs8), pkcs8 }
  } catch { throw new Error('That passphrase is not right.') }
}
/** The public key that belongs to a private key (so a restored backup can be checked against what is published). */
export async function publicFromPkcs8(pkcs8: Uint8Array): Promise<string> {
  const k = await subtle().importKey('pkcs8', buf(pkcs8), CURVE, true, ['deriveBits'])
  const jwk = await subtle().exportKey('jwk', k)
  const pub = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, CURVE, true, [])
  return b64(new Uint8Array(await subtle().exportKey('raw', pub)))
}

/** The shared AES key for one conversation between two members. Both sides derive the same key. */
export async function conversationKey(myPrivate: CryptoKey, theirPublic: string, conversationId: string, myId: string, theirId: string): Promise<CryptoKey> {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(theirPublic) }, myPrivate, 256)
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const [x, y] = [myId, theirId].sort()
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(te.encode('vybe-e2ee-v1')), info: buf(te.encode(`dm:${conversationId}:${x}:${y}`)) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
/** A key for something other than messages (e.g. an end-to-end encrypted call), separated from the message key by its label. */
export async function labelledKey(myPrivate: CryptoKey, theirPublic: string, label: string): Promise<string> {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(theirPublic) }, myPrivate, 256)
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveBits'])
  return b64(new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(te.encode('vybe-e2ee-v1')), info: buf(te.encode(label)) }, hk, 256)))
}

const aad = (conversationId: string, sender: string, epoch?: number) => buf(te.encode(`${conversationId}|${sender}${epoch ? `|${epoch}` : ''}`))

export type Envelope =
  | { t: 'text'; m: string }
  | { t: 'media'; kind: 'image' | 'video'; mime: string; key: string; iv: string; size: number; m?: string; /** a round video note, and its length */ note?: boolean; ms?: number }
  | { t: 'voice'; mime: string; key: string; iv: string; ms: number }
  | { t: 'file'; name: string; mime: string; key: string; iv: string; size: number }

export async function encryptEnvelope(key: CryptoKey, env: Envelope, conversationId: string, sender: string, epoch?: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: aad(conversationId, sender, epoch) }, key, buf(te.encode(JSON.stringify(env)))))
  return `${PREFIX}${b64(iv)}.${b64(ct)}`
}
export async function decryptEnvelope(key: CryptoKey, body: string, conversationId: string, sender: string, epoch?: number): Promise<Envelope> {
  if (!isCiphertext(body)) throw new Error('Not an encrypted message')
  const [iv, ct] = body.slice(PREFIX.length).split('.')
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(iv)), additionalData: aad(conversationId, sender, epoch) }, key, buf(unb64(ct)))
  return JSON.parse(td.decode(plain)) as Envelope
}

/** Encrypts a file with a brand-new key; the key and IV go inside the (encrypted) message envelope. */
export async function encryptBlob(data: ArrayBuffer): Promise<{ cipher: Blob; key: string; iv: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await subtle().importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt'])
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv) }, k, data)
  return { cipher: new Blob([ct], { type: 'application/octet-stream' }), key: b64(raw), iv: b64(iv) }
}
export async function decryptBlob(cipher: ArrayBuffer, key: string, iv: string, mime: string): Promise<Blob> {
  const k = await subtle().importKey('raw', buf(unb64(key)), 'AES-GCM', false, ['decrypt'])
  return new Blob([await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(iv)) }, k, cipher)], { type: mime })
}

/** The "security code" two people compare (in person or on a call) to be sure nobody swapped a key. Same on both phones. */
export async function securityCode(pubA: string, pubB: string): Promise<string> {
  const [x, y] = [pubA, pubB].sort()
  const h = new Uint8Array(await subtle().digest('SHA-256', buf(te.encode(`vybe-code-v1|${x}|${y}`))))
  const groups: string[] = []
  for (let i = 0; i < 24; i += 2) groups.push(String(((h[i] << 8) | h[i + 1]) % 100000).padStart(5, '0'))
  return groups.join(' ')
}
/** A short fingerprint of ONE public key, remembered so a later change can be flagged. */
export async function keyFingerprint(pub: string): Promise<string> {
  return b64(new Uint8Array(await subtle().digest('SHA-256', buf(te.encode(pub))))).slice(0, 22)
}

/* ---------------------------------------------------------------- recovery key (a second, high-entropy way to unlock the backup) */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   // Crockford base32: no I, L, O or U, so a written-down key is hard to misread

/** 160 random bits shown as eight groups of four characters, e.g. "7K3Q-M9XD-…". The server never sees it. */
export function newRecoveryKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(20))
  let bits = 0, value = 0, out = ''
  for (const byte of raw) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 } }
  return out.match(/.{4}/g)!.join('-')
}
/** Accepts what people actually type: any case, spaces or dashes, and the look-alike letters O/I/L. */
export function normaliseRecoveryKey(s: string): Uint8Array | null {
  const c = s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(c)) return null
  let bits = 0, value = 0; const out: number[] = []
  for (const ch of c) { value = (value << 5) | ALPHABET.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 } }
  return new Uint8Array(out)
}
const recoveryAesKey = async (raw: Uint8Array) =>
  subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(te.encode('vybe-recovery-v1')), info: buf(te.encode('key-backup')) }, await subtle().importKey('raw', buf(raw), 'HKDF', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
export interface RecoveryBackup { v: 1; iv: string; ct: string }
export async function backupWithRecoveryKey(pkcs8: Uint8Array, recoveryKey: string): Promise<RecoveryBackup> {
  const raw = normaliseRecoveryKey(recoveryKey); if (!raw) throw new Error('Invalid recovery key')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(te.encode('vybe-key-recovery-v1')) }, await recoveryAesKey(raw), buf(pkcs8)))
  return { v: 1, iv: b64(iv), ct: b64(ct) }
}
export async function restoreWithRecoveryKey(backup: RecoveryBackup, recoveryKey: string): Promise<{ privateKey: CryptoKey; pkcs8: Uint8Array }> {
  const raw = normaliseRecoveryKey(recoveryKey)
  if (!raw || backup.v !== 1) throw new Error('That recovery key is not right.')
  try {
    const pkcs8 = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(backup.iv)), additionalData: buf(te.encode('vybe-key-recovery-v1')) }, await recoveryAesKey(raw), buf(unb64(backup.ct))))
    return { privateKey: await lock(pkcs8), pkcs8 }
  } catch { throw new Error('That recovery key is not right.') }
}

/* ---------------------------------------------------------------- group keys */
export const newGroupKey = () => crypto.getRandomValues(new Uint8Array(32))
const wrapKey = async (myPrivate: CryptoKey, theirPublic: string, conversationId: string, epoch: number, memberId: string) => {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(theirPublic) }, myPrivate, 256)
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(te.encode('vybe-e2ee-v1')), info: buf(te.encode(`wrap:${conversationId}:${epoch}:${memberId}`)) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const wrapAad = (conversationId: string, epoch: number, memberId: string) => buf(te.encode(`${conversationId}|${epoch}|${memberId}`))
/** Seals the group key so that only `memberId` (holding the private key for `memberPublic`) can open it. `myPrivate` identifies who sealed it. */
export async function wrapGroupKey(myPrivate: CryptoKey, memberPublic: string, groupKey: Uint8Array, conversationId: string, epoch: number, memberId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: wrapAad(conversationId, epoch, memberId) }, await wrapKey(myPrivate, memberPublic, conversationId, epoch, memberId), buf(groupKey)))
  return `${b64(iv)}.${b64(ct)}`
}
/** Opens a delivered group key. Returns the raw bytes (kept in memory only, so this member can hand it to newcomers) and a usable key. */
export async function unwrapGroupKey(myPrivate: CryptoKey, wrapperPublic: string, wrapped: string, conversationId: string, epoch: number, myId: string): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const [iv, ct] = wrapped.split('.')
  const raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(unb64(iv)), additionalData: wrapAad(conversationId, epoch, myId) }, await wrapKey(myPrivate, wrapperPublic, conversationId, epoch, myId), buf(unb64(ct))))
  if (raw.length !== 32) throw new Error('Bad group key')
  return { raw, key: await groupMessageKey(raw) }
}
export const groupMessageKey = (raw: Uint8Array) => subtle().importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])

/* ---------------------------------------------------------------- VYBE-assisted recovery (opt-in) */
/** Used only to check, before the key is handed to the recovery service, that it really is the member's published key. */
export { publicFromPkcs8 as publicKeyOf }
