import { supabase, supabaseKey, supabaseUrl } from './supabase'

/**
 * One upload transport for every bucket, straight from the browser to Supabase Storage (never through an app server).
 *  - Small files (≤ 6 MB) go in one request with real byte progress.
 *  - Larger files use Supabase's resumable (TUS) protocol in 6 MB chunks: a dropped connection resumes from the last
 *    confirmed byte instead of starting again.
 *  - Transient failures (network, timeouts, 5xx, 429) retry with exponential backoff and jitter; permanent ones (bad type,
 *    too large, not allowed, already exists) fail at once with a plain message.
 *  - At most a few uploads run at the same time; the rest wait in line, so one big video cannot starve everything else.
 * Authorisation stays where it was: the member's own session token, checked by the bucket's policies, size and type limits.
 */

export const CHUNK = 6 * 1024 * 1024                       // Supabase's resumable uploads require exactly 6 MB chunks
export const RESUMABLE_FROM = CHUNK                         // above this, use the resumable protocol
const MAX_ATTEMPTS = 6

export interface Reply { status: number; header: (name: string) => string | null; text: string }
export interface Req {
  method: 'POST' | 'PATCH' | 'HEAD' | 'DELETE'; url: string; headers: Record<string, string>; body?: Blob
  onProgress?: (sent: number) => void; signal?: AbortSignal
}
/** XMLHttpRequest, because fetch still cannot report upload progress in most browsers. */
export function xhrRequest(r: Req): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open(r.method, r.url)
    for (const [k, v] of Object.entries(r.headers)) x.setRequestHeader(k, v)
    if (r.onProgress) x.upload.onprogress = e => r.onProgress!(e.loaded)
    x.onload = () => resolve({ status: x.status, header: n => x.getResponseHeader(n), text: x.responseText })
    x.onerror = () => reject(new UploadError('network', 'The connection dropped.'))
    x.ontimeout = () => reject(new UploadError('network', 'The upload timed out.'))
    x.onabort = () => reject(new UploadError('cancelled', 'Upload cancelled.'))
    if (r.signal) { if (r.signal.aborted) { x.abort(); return } r.signal.addEventListener('abort', () => x.abort(), { once: true }) }
    x.send(r.body ?? null)
  })
}

export type UploadErrorKind = 'network' | 'server' | 'auth' | 'rejected' | 'too_large' | 'exists' | 'cancelled'
export class UploadError extends Error {
  constructor(public kind: UploadErrorKind, message: string) { super(message) }
  get retryable() { return this.kind === 'network' || this.kind === 'server' }
}

/** Turns a storage reply into a plain, member-facing error (never a raw server dump). */
export function classify(status: number, text: string): UploadError {
  const msg = (() => { try { return String(JSON.parse(text)?.message ?? JSON.parse(text)?.error ?? '') } catch { return text } })()
  if (status === 413 || /maximum allowed size|too large|exceeded/i.test(msg)) return new UploadError('too_large', 'This file is larger than the upload limit.')
  if (status === 409 || /already exists|Duplicate/i.test(msg)) return new UploadError('exists', 'This file was already uploaded.')
  if (status === 401) return new UploadError('auth', 'Your session expired. Sign in again and retry.')
  if (status === 403) return new UploadError('rejected', 'You are not allowed to upload here.')
  if (status === 415 || /mime type|not supported/i.test(msg)) return new UploadError('rejected', 'This type of file is not allowed here.')
  if (status === 429 || status >= 500 || status === 0) return new UploadError('server', 'The server is busy. Retrying…')
  return new UploadError('rejected', msg ? `Upload failed: ${msg.slice(0, 140)}` : `Upload failed (${status}).`)
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
export const backoff = (attempt: number, rnd = Math.random) => Math.min(15_000, 500 * 2 ** attempt) * (0.6 + 0.8 * rnd())
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new UploadError('cancelled', 'Upload cancelled.')) }, { once: true })
})

export interface UploadOpts {
  bucket: string; path: string; file: Blob; contentType: string; cacheControl?: string
  onProgress?: (sent: number, total: number) => void; signal?: AbortSignal
  /** Identifies the file across page loads (see fingerprint); resumable uploads remember their session under it. */
  fingerprint?: string
  /** Test seams. */
  request?: (r: Req) => Promise<Reply>; token?: () => Promise<string>; sleep?: (ms: number, s?: AbortSignal) => Promise<void>
}
async function sessionToken() {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? supabaseKey
}

/** Uploads one object, choosing the single-request or resumable protocol by size. Resolves when Storage has confirmed it. */
export async function uploadObject(o: UploadOpts): Promise<void> {
  return o.file.size > RESUMABLE_FROM ? resumable(o) : single(o)
}

async function single(o: UploadOpts) {
  const send = o.request ?? xhrRequest, token = o.token ?? sessionToken, sleep = o.sleep ?? wait
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await send({
        method: 'POST', url: `${supabaseUrl}/storage/v1/object/${o.bucket}/${o.path}`, body: o.file, signal: o.signal,
        headers: { authorization: `Bearer ${await token()}`, apikey: supabaseKey, 'content-type': o.contentType, 'cache-control': `max-age=${o.cacheControl ?? '3600'}`, 'x-upsert': 'false' },
        onProgress: n => o.onProgress?.(Math.min(n, o.file.size), o.file.size),
      })
      if (r.status >= 200 && r.status < 300) { o.onProgress?.(o.file.size, o.file.size); return }
      throw classify(r.status, r.text)
    } catch (e) {
      const err = e instanceof UploadError ? e : new UploadError('network', 'The connection dropped.')
      // A retried request that the server had in fact stored answers "already exists": it is there, so it succeeded.
      if (err.kind === 'exists' && attempt > 0) { o.onProgress?.(o.file.size, o.file.size); return }
      if (!err.retryable || attempt + 1 >= MAX_ATTEMPTS) throw err
      await sleep(backoff(attempt), o.signal)
    }
  }
}

async function resumable(o: UploadOpts) {
  const send = o.request ?? xhrRequest, token = o.token ?? sessionToken, sleep = o.sleep ?? wait
  const base = `${supabaseUrl}/storage/v1/upload/resumable`
  const auth = async () => ({ authorization: `Bearer ${await token()}`, apikey: supabaseKey, 'tus-resumable': '1.0.0' })
  let location: string | null = null, offset = 0, failures = 0
  // A session left by an earlier page load for this same file and destination: ask the server how far it got, then continue.
  const saved = o.fingerprint ? resumeStore.get(o.fingerprint) : null
  if (saved && saved.bucket === o.bucket && saved.path === o.path && saved.size === o.file.size) {
    try {
      const h = await send({ method: 'HEAD', url: saved.location, signal: o.signal, headers: await auth() })
      if (h.status === 200 || h.status === 204) { location = saved.location; offset = Number(h.header('upload-offset') ?? 0) }
    } catch { /* start a new session below */ }
  }
  const forget = () => { if (o.fingerprint) resumeStore.remove(o.fingerprint) }
  o.signal?.addEventListener('abort', forget, { once: true })
  const retry = async (e: unknown) => {
    const err = e instanceof UploadError ? e : new UploadError('network', 'The connection dropped.')
    if (!err.retryable || ++failures >= MAX_ATTEMPTS) throw err
    await sleep(backoff(failures - 1), o.signal)
  }
  while (true) {
    try {
      if (!location) {
        const meta = { bucketName: o.bucket, objectName: o.path, contentType: o.contentType, cacheControl: o.cacheControl ?? '3600' }
        const r = await send({ method: 'POST', url: base, signal: o.signal, headers: {
          ...(await auth()), 'upload-length': String(o.file.size), 'x-upsert': 'false',
          'upload-metadata': Object.entries(meta).map(([k, v]) => `${k} ${b64(v)}`).join(','),
        } })
        if (r.status !== 201) throw classify(r.status, r.text)
        const loc = r.header('location')
        if (!loc) throw new UploadError('server', 'The server did not start the upload.')
        location = loc.startsWith('http') ? loc : new URL(loc, base).toString()
        offset = 0
        if (o.fingerprint) resumeStore.set(o.fingerprint, { bucket: o.bucket, path: o.path, location, size: o.file.size, name: (o.file as File).name ?? '', at: Date.now() })
      }
      while (offset < o.file.size) {
        const chunk = o.file.slice(offset, Math.min(offset + CHUNK, o.file.size)), at = offset
        const r = await send({ method: 'PATCH', url: location, body: chunk, signal: o.signal,
          headers: { ...(await auth()), 'upload-offset': String(at), 'content-type': 'application/offset+octet-stream' },
          onProgress: n => o.onProgress?.(Math.min(at + n, o.file.size), o.file.size) })
        if (r.status === 409) {                             // our idea of the offset is stale: ask the server where it is
          const h = await send({ method: 'HEAD', url: location, signal: o.signal, headers: await auth() })
          offset = Number(h.header('upload-offset') ?? at); continue
        }
        if (r.status === 404 || r.status === 410) { location = null; break }   // the session expired: start a new one
        if (r.status !== 204 && r.status !== 200) throw classify(r.status, r.text)
        offset = Number(r.header('upload-offset') ?? at + chunk.size)
        failures = 0
        o.onProgress?.(offset, o.file.size)
      }
      if (location && offset >= o.file.size) { forget(); return }
    } catch (e) {
      // Refused for good (auth, type, size, cancelled): forget the session. A dropped connection keeps it for the next page load.
      if (e instanceof UploadError && !e.retryable) forget()
      await retry(e)
      // After a dropped connection, ask the server how much it already has, then carry on from there.
      if (location) {
        try {
          const h = await send({ method: 'HEAD', url: location, signal: o.signal, headers: await auth() })
          if (h.status === 404 || h.status === 410) location = null
          else offset = Number(h.header('upload-offset') ?? offset)
        } catch { /* the next loop retries */ }
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------------ resume after reload */
// Storage keeps an unfinished resumable upload for 24 hours. The page remembers where each one is going, keyed by the file's
// name, size, type and modification time, so picking the same file again after a reload or crash continues it instead of
// starting over. The browser cannot reopen a file by itself, so the member re-picks it; nothing else about it is stored.
export interface Resume { bucket: string; path: string; location: string; size: number; name: string; at: number }
const RESUME_KEY = 'vybe:uploads:v1', RESUME_TTL = 23 * 3600_000
const readAll = (): Record<string, Resume> => {
  try {
    const all = JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as Record<string, Resume>
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v && Date.now() - v.at < RESUME_TTL))
  } catch { return {} }
}
const writeAll = (all: Record<string, Resume>) => { try { Object.keys(all).length ? localStorage.setItem(RESUME_KEY, JSON.stringify(all)) : localStorage.removeItem(RESUME_KEY) } catch { /* storage unavailable */ } }
export const resumeStore = {
  get: (k: string): Resume | null => readAll()[k] ?? null,
  set: (k: string, v: Resume) => writeAll({ ...readAll(), [k]: v }),
  remove: (k: string) => { const all = readAll(); if (k in all) { delete all[k]; writeAll(all) } },
  /** Unfinished uploads from earlier page loads (newest first), for "pick the same file to continue". */
  pending: (bucket?: string, owner?: string) => Object.entries(readAll()).map(([key, v]) => ({ ...v, key }))
    .filter(v => (!bucket || v.bucket === bucket) && (!owner || v.path.startsWith(`${owner}/`))).sort((a, b) => b.at - a.at),
}
/** Same file, same person, same destination bucket → same key. Small files never need it (they upload in one request). */
export const fingerprint = (bucket: string, owner: string, f: { name?: string; size: number; type: string; lastModified?: number }) =>
  [bucket, owner, f.name ?? '', f.size, f.type, f.lastModified ?? 0].join('|')

/* ------------------------------------------------------------------------------------------------ bounded queue */
const LIMIT = () => ((navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection?.saveData ? 1 : 3)
let running = 0
const waiting: (() => void)[] = []
/** Runs at most a few uploads at once; `first` jumps the line (e.g. the cover image). */
export async function queued<T>(job: () => Promise<T>, first = false): Promise<T> {
  if (running >= LIMIT()) await new Promise<void>(r => (first ? waiting.unshift(r) : waiting.push(r)))
  running++
  try { return await job() } finally { running--; waiting.shift()?.() }
}
