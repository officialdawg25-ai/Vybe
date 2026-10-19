import { supabase } from './supabase'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const VIDEO = ['video/mp4', 'video/webm', 'video/quicktime']

export type MediaCheck = { ok: true; type: 'image' | 'video' } | { ok: false; error: string }

/** Client-side pre-check; the bucket enforces the same MIME and size limits server-side. */
export function validateMedia(file: { type: string; size: number }): MediaCheck {
  if (IMAGE.includes(file.type)) {
    return file.size <= MAX_IMAGE_BYTES ? { ok: true, type: 'image' } : { ok: false, error: 'Images must be 10 MB or smaller.' }
  }
  if (VIDEO.includes(file.type)) {
    return file.size <= MAX_VIDEO_BYTES ? { ok: true, type: 'video' } : { ok: false, error: 'Videos must be 50 MB or smaller.' }
  }
  return { ok: false, error: 'Use a JPG, PNG, WebP, GIF, MP4, WebM or MOV file.' }
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }

/** Objects live under `<user id>/` — storage policies key off that folder. */
export const mediaPath = (uid: string, mime: string) => `${uid}/${crypto.randomUUID()}.${EXT[mime] ?? 'bin'}`

export async function uploadMedia(uid: string, file: File): Promise<{ path: string; type: 'image' | 'video' }> {
  const check = validateMedia(file)
  if (!check.ok) throw new Error(check.error)
  const path = mediaPath(uid, file.type)
  const { error } = await supabase.storage.from('media').upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw new Error(error.message)
  return { path, type: check.type }
}

const cache = new Map<string, { url: string; exp: number }>()
/** Signed URLs are cached per path until shortly before expiry. */
export async function signedUrl(path: string): Promise<string | null> {
  const hit = cache.get(path)
  if (hit && hit.exp > Date.now() + 60_000) return hit.url
  const { data, error } = await supabase.storage.from('media').createSignedUrl(path, 3600)
  if (error || !data) return null
  cache.set(path, { url: data.signedUrl, exp: Date.now() + 3600_000 })
  return data.signedUrl
}
