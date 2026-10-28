import type { Manifest, QueuedScan } from './offline'

/**
 * Where a door phone keeps its offline data and its queue of scans not yet uploaded: IndexedDB, encrypted with AES-GCM under a
 * key the browser created as non-extractable (page code can use it but never read it out). This protects an exported copy of
 * the storage; it does not protect against someone who has the unlocked phone, which is why manifests are short-lived and
 * every upload is checked by the server. Falls back to memory (lost on reload) where IndexedDB is unavailable.
 */
const DB = 'vybe-door', STORE = 'kv'
const mem = new Map<string, unknown>()

function open(): Promise<IDBDatabase | null> {
  return new Promise(res => {
    try {
      const r = indexedDB.open(DB, 1)
      r.onupgradeneeded = () => r.result.createObjectStore(STORE)
      r.onsuccess = () => res(r.result); r.onerror = () => res(null)
    } catch { res(null) }
  })
}
async function raw<T>(mode: 'get' | 'put' | 'delete', key: string, value?: unknown): Promise<T | undefined> {
  const db = await open()
  if (!db) { if (mode === 'get') return mem.get(key) as T; if (mode === 'put') mem.set(key, value); else mem.delete(key); return undefined }
  return new Promise(res => {
    const tx = db.transaction(STORE, mode === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore(STORE)
    const rq = mode === 'get' ? st.get(key) : mode === 'put' ? st.put(value, key) : st.delete(key)
    rq.onsuccess = () => res(mode === 'get' ? (rq.result as T) : undefined); rq.onerror = () => res(undefined)
  })
}
async function key(): Promise<CryptoKey | null> {
  if (!globalThis.crypto?.subtle) return null
  let k = await raw<CryptoKey>('get', 'key')
  if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await raw('put', 'key', k) }
  return k
}
async function put(name: string, value: unknown) {
  const k = await key(), data = new TextEncoder().encode(JSON.stringify(value))
  if (!k) return raw('put', name, value)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  await raw('put', name, { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data) })
}
async function get<T>(name: string): Promise<T | null> {
  const v = await raw<{ iv: Uint8Array; ct: ArrayBuffer } | T>('get', name)
  if (!v) return null
  const k = await key()
  if (!k || !(v as { ct?: unknown }).ct) return v as T
  try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: (v as { iv: Uint8Array<ArrayBuffer> }).iv }, k, (v as { ct: ArrayBuffer }).ct))) as T } catch { return null }
}

export interface OfflineKit { manifest: Manifest; loadedAt: number }
export const saveKit = (session: string, kit: OfflineKit) => put(`kit:${session}`, kit)
export const loadKit = (session: string) => get<OfflineKit>(`kit:${session}`)
export const dropKit = (session: string) => raw('delete', `kit:${session}`)
export const saveQueue = (session: string, q: QueuedScan[]) => put(`queue:${session}`, q)
export const loadQueue = async (session: string) => (await get<QueuedScan[]>(`queue:${session}`)) ?? []
