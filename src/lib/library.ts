import { supabase } from './supabase'
import { isMissingSchema } from './tickets'
import { discardUploads, uploadMedia, type Transfer } from './media'
import { queued, uploadObject } from './upload'

/** One photo or video in a member's (or an organisation's) media library. `status` is set only by the media-process worker. */
export interface Asset {
  id: string; owner: string; organization_id: string | null; path: string; kind: 'image' | 'video'; mime: string; bytes: number
  width: number | null; height: number | null; duration_ms: number | null; thumb_path: string | null; title: string
  status: 'uploaded' | 'processing' | 'ready' | 'failed'; error: string | null; created_at: string
}
export interface Thumb { blob: Blob; width: number; height: number; duration_ms: number | null }

const THUMB = 480
/**
 * A small still for the library grid (and a video's poster frame), made in the browser from the file already picked:
 * no extra download, and nothing leaves the device until it is uploaded to the member's own folder. Null when the
 * browser cannot decode the file (the original still uploads; the library then shows an icon).
 */
export async function makeThumb(file: File): Promise<Thumb | null> {
  try {
    if (file.type.startsWith('image/')) {
      const bmp = await createImageBitmap(file)
      const out = await draw(bmp, bmp.width, bmp.height)
      bmp.close()
      return out && { ...out, duration_ms: null }
    }
    if (file.type.startsWith('video/')) {
      const url = URL.createObjectURL(file)
      try {
        const v = document.createElement('video')
        v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url
        await once(v, 'loadedmetadata')
        const dur = Number.isFinite(v.duration) ? v.duration : 0
        v.currentTime = Math.min(1, dur / 10 || 0.1)
        await once(v, 'seeked')
        const out = await draw(v, v.videoWidth, v.videoHeight)
        return out && { ...out, duration_ms: dur ? Math.round(dur * 1000) : null }
      } finally { URL.revokeObjectURL(url) }
    }
  } catch { /* undecodable here: no thumbnail */ }
  return null
}
const once = (el: HTMLElement, ev: string) => new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), 8000)
  el.addEventListener(ev, () => { clearTimeout(t); res() }, { once: true })
  el.addEventListener('error', () => { clearTimeout(t); rej(new Error('decode')) }, { once: true })
})
async function draw(src: CanvasImageSource, w: number, h: number): Promise<Omit<Thumb, 'duration_ms'> | null> {
  if (!w || !h) return null
  const k = Math.min(1, THUMB / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/webp', 0.8))
  return blob ? { blob, width: w, height: h } : null
}

/** Uploads a still made by makeThumb into the member's own folder. */
export async function uploadThumb(uid: string, t: Thumb, signal?: AbortSignal): Promise<string> {
  const type = t.blob.type || 'image/webp'
  const path = `${uid}/${crypto.randomUUID()}.${type === 'image/jpeg' ? 'jpg' : 'webp'}`
  await queued(() => uploadObject({ bucket: 'media', path, file: t.blob, contentType: type, cacheControl: '31536000', signal }))
  return path
}

/**
 * Records an uploaded file in the library and asks the worker to check it. Returns null (and records nothing) when the
 * server does not have the library yet; the upload itself is unaffected.
 */
export async function registerAsset(a: { path: string; kind: 'image' | 'video'; mime: string; bytes: number; thumb?: Thumb | null; thumb_path?: string | null; organization_id?: string | null; title?: string }): Promise<string | null> {
  const { data, error } = await supabase.from('media_assets').insert({
    path: a.path, kind: a.kind, mime: a.mime, bytes: a.bytes, thumb_path: a.thumb_path ?? null, organization_id: a.organization_id ?? null, title: (a.title ?? '').slice(0, 120),
    width: a.thumb?.width ?? null, height: a.thumb?.height ?? null, duration_ms: a.thumb?.duration_ms ?? null,
  }).select('id').single()
  if (error) { if (isMissingSchema(error)) return null; throw error }
  void processAsset(data.id as string)
  return data.id as string
}

/** Runs the server check (media-process). Safe to call again: a ready asset is left as it is. */
export async function processAsset(id: string): Promise<{ status: string; error?: string } | null> {
  const { data, error } = await supabase.functions.invoke('media-process', { body: { asset_id: id } })
  if (error) return null
  return data as { status: string; error?: string }
}

/** Upload a file straight into a library (personal, or an organisation's): original, still, record, server check. */
export async function addToLibrary(uid: string, file: File, opts: Transfer & { organizationId?: string | null } = {}): Promise<string | null> {
  const [up, thumb] = await Promise.all([uploadMedia(uid, file, opts), makeThumb(file)])
  let thumbPath: string | null = null
  try { if (thumb) thumbPath = await uploadThumb(uid, thumb, opts.signal) } catch { /* the original is what matters */ }
  try {
    return await registerAsset({ path: up.path, kind: up.type, mime: file.type, bytes: file.size, thumb, thumb_path: thumbPath, organization_id: opts.organizationId ?? null, title: file.name.replace(/\.[^.]+$/, '') })
  } catch (e) { discardUploads('media', [up.path, thumbPath]); throw e }
}

export async function listAssets(orgId?: string | null): Promise<Asset[] | null> {
  let q = supabase.from('media_assets').select('*').order('created_at', { ascending: false }).limit(120)
  q = orgId ? q.eq('organization_id', orgId) : q.is('organization_id', null)
  const { data, error } = await q
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (data ?? []) as Asset[]
}

/** True when something on VYBE still shows this file (a post, a profile, an event, a community or a page). */
async function inUse(path: string): Promise<boolean> {
  const checks = await Promise.all([
    supabase.from('post_media').select('post_id', { head: true, count: 'exact' }).eq('path', path),
    supabase.from('posts').select('id', { head: true, count: 'exact' }).eq('media_path', path),
    supabase.from('profiles').select('id', { head: true, count: 'exact' }).or(`avatar_path.eq.${path},cover_path.eq.${path}`),
    supabase.from('events').select('id', { head: true, count: 'exact' }).or(`cover_path.eq.${path},hero_video_path.eq.${path}`),
    supabase.from('communities').select('id', { head: true, count: 'exact' }).eq('cover_path', path),
    supabase.from('organizations').select('id', { head: true, count: 'exact' }).or(`avatar_path.eq.${path},cover_path.eq.${path}`),
  ])
  // If any check could not run, assume it is in use: losing a file a post shows is worse than keeping a spare one.
  return checks.some(c => c.error || (c.count ?? 0) > 0)
}

/**
 * Removes the record. The stored files go too when they are the caller's own and nothing still shows them; otherwise they
 * stay (a post keeps its photo). Returns whether the files were deleted.
 */
export async function deleteAsset(a: Asset, uid: string): Promise<boolean> {
  const { error } = await supabase.from('media_assets').delete().eq('id', a.id)
  if (error) throw error
  if (a.owner !== uid || await inUse(a.path)) return false
  discardUploads('media', [a.path, a.thumb_path])
  return true
}
