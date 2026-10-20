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

/** Signed URLs are cached per path until shortly before expiry, and concurrent requests for one path share a single call. */
export async function signedUrl(path: string): Promise<string | null> {
  const hit = fresh(path)
  if (hit) return hit
  const pending = inflight.get(path)
  if (pending) return pending
  const p = (async () => {
    const { data, error } = await supabase.storage.from('media').createSignedUrl(path, 3600)
    if (error || !data) return null
    cache.set(path, { url: data.signedUrl, exp: Date.now() + 3600_000 })
    return data.signedUrl
  })().finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

/** Signs many paths in ONE request (feeds call this as soon as a page of posts arrives), so images stop waiting in line. */
export async function primeSignedUrls(paths: (string | null | undefined)[]) {
  const need = [...new Set(paths.filter((p): p is string => Boolean(p)))].filter(p => !fresh(p) && !inflight.has(p))
  if (!need.length) return
  const batch = (async () => {
    const { data } = await supabase.storage.from('media').createSignedUrls(need, 3600)
    for (const r of data ?? []) if (r.path && r.signedUrl) cache.set(r.path, { url: r.signedUrl, exp: Date.now() + 3600_000 })
  })().catch(() => {})
  for (const p of need) inflight.set(p, batch.then(() => fresh(p)).finally(() => inflight.delete(p)))
  await batch
}

/** Synchronous cache read so already-signed images render on the first paint. */
export const cachedUrl = (path?: string | null) => (path ? fresh(path) : null)
