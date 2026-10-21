import { supabase } from './supabase'

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const VIDEO = ['video/mp4', 'video/webm', 'video/quicktime']
export const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg']

export type MediaCheck = { ok: true; type: 'image' | 'video' } | { ok: false; error: string }

/** Client-side pre-check; the bucket enforces the same MIME and size limits server-side. */
export function validateMedia(file: { type: string; size: number }): MediaCheck {
  if (IMAGE.includes(file.type)) {
    return file.size <= MAX_IMAGE_BYTES ? { ok: true, type: 'image' } : { ok: false, error: `Images must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.` }
  }
  if (VIDEO.includes(file.type)) {
    return file.size <= MAX_VIDEO_BYTES ? { ok: true, type: 'video' } : { ok: false, error: 'Videos must be 50 MB or smaller.' }
  }
  return { ok: false, error: 'Use a JPG, PNG, WebP, GIF, MP4, WebM or MOV file.' }
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }

/** Objects live under `<user id>/` — storage policies key off that folder. */
export const mediaPath = (uid: string, mime: string) => `${uid}/${crypto.randomUUID()}.${EXT[mime] ?? 'bin'}`

/**
 * Downscales big photos in the browser before upload (max edge `max`, WebP). Smaller files load far faster for
 * everyone else. GIFs and files that are already small are left alone; any failure falls back to the original.
 */
export async function shrinkImage(file: File, max = 2048): Promise<File> {
  if (file.type === 'image/gif' || !file.type.startsWith('image/')) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size < 1.2 * 1024 * 1024) { bmp.close?.(); return file }
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.()
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/webp', 0.86))
    return blob && blob.size < file.size ? new File([blob], 'photo.webp', { type: 'image/webp' }) : file
  } catch { return file }
}

export async function uploadMedia(uid: string, file: File): Promise<{ path: string; type: 'image' | 'video' }> {
  const check = validateMedia(file)
  if (!check.ok) throw new Error(check.error)
  // Uploaded exactly as chosen: no re-compression or resizing, so photos and videos keep their original resolution and quality.
  const path = mediaPath(uid, file.type)
  const { error } = await supabase.storage.from('media').upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' })
  if (error) throw new Error(error.message)
  return { path, type: check.type }
}

const cache = new Map<string, { url: string; exp: number }>()
const inflight = new Map<string, Promise<string | null>>()
const fresh = (path: string) => { const hit = cache.get(path); return hit && hit.exp > Date.now() + 60_000 ? hit.url : null }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const TTL = 3600

/** Signs one path, retrying transient failures (network, rate limits) so a hiccup never leaves a picture permanently blank. */
async function sign(path: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error } = await supabase.storage.from('media').createSignedUrl(path, TTL)
      if (data?.signedUrl) { cache.set(path, { url: data.signedUrl, exp: Date.now() + TTL * 1000 }); return data.signedUrl }
      if (error && /not.?found|does not exist/i.test(error.message)) return null          // really missing: do not hammer
    } catch { /* network error: retry */ }
    await sleep(350 * 2 ** attempt)
  }
  return null
}

/** Signed URLs are cached per path until shortly before expiry, and concurrent requests for one path share a single call. */
export async function signedUrl(path: string): Promise<string | null> {
  const hit = fresh(path)
  if (hit) return hit
  const pending = inflight.get(path)
  if (pending) return pending
  const p = sign(path).finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

/** Forget a cached URL (it expired or failed to load) so the next read signs a new one. */
export const invalidateSigned = (path?: string | null) => { if (path) cache.delete(path) }
/** Milliseconds until a cached URL needs refreshing (null when nothing is cached). */
export const signedExpiresIn = (path?: string | null) => { const hit = path ? cache.get(path) : null; return hit ? Math.max(0, hit.exp - Date.now() - 90_000) : null }

/**
 * Signs many paths in ONE request (feeds call this as soon as a page of posts arrives), so images stop waiting in line.
 * Any path the batch could not sign is retried on its own, so a partial failure never blanks a picture.
 */
export async function primeSignedUrls(paths: (string | null | undefined)[]) {
  const need = [...new Set(paths.filter((p): p is string => Boolean(p)))].filter(p => !fresh(p) && !inflight.has(p))
  if (!need.length) return
  const batch = (async () => {
    const { data } = await supabase.storage.from('media').createSignedUrls(need, TTL)
    for (const r of data ?? []) if (r.path && r.signedUrl) cache.set(r.path, { url: r.signedUrl, exp: Date.now() + TTL * 1000 })
  })().catch(() => {})
  for (const p of need) inflight.set(p, batch.then(() => fresh(p) ?? sign(p)).finally(() => inflight.delete(p)))
  await batch
}

/** Synchronous cache read so already-signed images render on the first paint. */
export const cachedUrl = (path?: string | null) => (path ? fresh(path) : null)

/* ---------------------------------------------------------------- chat files (any type) */
export const MAX_FILE_BYTES = 200 * 1024 * 1024
const BLOCKED = /\.(exe|msi|bat|cmd|com|scr|pif|js|jse|vbs|vbe|wsf|ps1|apk|jar|sh|dll|app|dmg|lnk|hta|reg|iso)$/i

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`)

/** Any document, archive, audio or other file may be sent in chat, except programs and scripts that can run on someone's device. */
export function validateAttachment(file: { name: string; size: number }): string | null {
  if (!file.size) return 'That file is empty.'
  if (BLOCKED.test(file.name)) return 'For safety, programs and scripts cannot be sent in chat.'
  if (file.size > MAX_FILE_BYTES) return `Files must be ${fileSize(MAX_FILE_BYTES)} or smaller.`
  return null
}

const safeExt = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase()

/** Uploads a chat file to the private `attachments` bucket under the sender's folder. */
export async function uploadAttachment(uid: string, file: File): Promise<{ path: string; name: string; size: number; mime: string }> {
  const err = validateAttachment(file); if (err) throw new Error(err)
  const path = `${uid}/${crypto.randomUUID()}.${safeExt(file.name)}`
  const { error } = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false, cacheControl: '3600' })
  if (error) throw new Error(/exceeded|too large|maximum/i.test(error.message) ? 'That file is larger than your storage upload limit.' : error.message)
  return { path, name: file.name.slice(0, 200), size: file.size, mime: (file.type || 'application/octet-stream').slice(0, 120) }
}

/** Short-lived download link for a chat file (saved under its original name). */
export async function signedFileUrl(path: string, name?: string): Promise<string | null> {
  const { data } = await supabase.storage.from('attachments').createSignedUrl(path, 600, name ? { download: name } : undefined)
  return data?.signedUrl ?? null
}

/* ---------------------------------------------------------------- songs from the member's own device */
export const AUDIO_FILE_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/webm']
const AUDIO_EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/webm': 'webm' }
export const MAX_SONG_BYTES = 50 * 1024 * 1024
/** Some phones report an empty or generic type for music files, so fall back to the file extension. */
export function audioMime(file: { name: string; type: string }): string | null {
  if (AUDIO_FILE_TYPES.includes(file.type)) return file.type === 'audio/mp3' ? 'audio/mpeg' : file.type === 'audio/m4a' ? 'audio/x-m4a' : file.type
  const ext = file.name.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase()
  return ({ mp3: 'audio/mpeg', m4a: 'audio/x-m4a', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', weba: 'audio/webm' } as Record<string, string>)[ext ?? ''] ?? null
}
export function validateSong(file: { name: string; type: string; size: number }): string | null {
  if (!audioMime(file)) return 'Choose an audio file (MP3, M4A, AAC, WAV, OGG, FLAC or OPUS).'
  if (file.size > MAX_SONG_BYTES) return `Songs must be ${MAX_SONG_BYTES / 1024 / 1024} MB or smaller.`
  return null
}
/** "Dua_Lipa-Houdini (Official).mp3" → "Dua Lipa-Houdini (Official)" */
export const titleFromFile = (name: string) => name.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)

export async function uploadSong(uid: string, file: File): Promise<string> {
  const err = validateSong(file); if (err) throw new Error(err)
  const mime = audioMime(file)!
  const path = `${uid}/${crypto.randomUUID()}.${AUDIO_EXT[mime] ?? 'mp3'}`
  const { error } = await supabase.storage.from('media').upload(path, file, { contentType: mime, upsert: false, cacheControl: '31536000' })
  if (error) throw new Error(error.message)
  return path
}
