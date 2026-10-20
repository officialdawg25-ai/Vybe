/** AES-256-GCM helpers for organizer bank details. The key lives only in the edge-function secret PAYOUT_ENC_KEY (base64, 32 bytes). */
const b64 = {
  enc: (u: Uint8Array) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s) },
  dec: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
}

async function key(keyB64: string, usage: KeyUsage[]) {
  const raw = b64.dec(keyB64)
  if (raw.length !== 32) throw new Error('PAYOUT_ENC_KEY must be 32 bytes, base64-encoded')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usage)
}

/** Returns base64(iv ‖ ciphertext). A fresh random IV is used every time. */
export async function encryptJson(keyB64: string, value: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await key(keyB64, ['encrypt']), new TextEncoder().encode(JSON.stringify(value))))
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length)
  return b64.enc(out)
}

/** `aad` (e.g. the account id) is authenticated: a ciphertext copied onto another account will not decrypt. */
export async function decryptJson<T = unknown>(keyB64: string, blob: string, aad: string): Promise<T> {
  const raw = b64.dec(blob)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: new TextEncoder().encode(aad) }, await key(keyB64, ['decrypt']), raw.slice(12))
  return JSON.parse(new TextDecoder().decode(pt)) as T
}

export const newKeyB64 = () => b64.enc(crypto.getRandomValues(new Uint8Array(32)))
