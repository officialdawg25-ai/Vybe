import { supabase } from './supabase'
import { uploadMedia, validateMedia } from './media'
import { learnAvatar } from './identity'
import { isMissingSchema } from './tickets'

/** Uploads an (already cropped) avatar, points the profile at it, and removes the previous file. */
export async function saveAvatar(uid: string, file: File, oldPath?: string | null) {
  const c = validateMedia(file)
  if (!c.ok || c.type !== 'image') throw new Error('Choose a JPG, PNG or WebP image under 25 MB.')
  const up = await uploadMedia(uid, file)
  // A still picture replaces any motion clip, so the profile never shows an old clip over the new photo.
  let { error } = await supabase.from('profiles').update({ avatar_path: up.path, avatar_motion_path: null }).eq('id', uid)
  if (error && isMissingSchema(error)) ({ error } = await supabase.from('profiles').update({ avatar_path: up.path }).eq('id', uid))
  if (error) { await supabase.storage.from('media').remove([up.path]); throw error }
  // Every avatar on screen (feed, comments, chats, rail, other tabs) switches now, before the old file is removed.
  learnAvatar(uid, up.path, oldPath)
  // The old file is no longer referenced by the profile, so storage policy already stops others reading it; removing it is cleanup.
  if (oldPath && oldPath !== up.path) await supabase.storage.from('media').remove([oldPath])
  return up.path
}

/** First-pass check for the file picker (before the cropper opens). */
export function checkAvatarFile(f: File): string | null {
  if (f.type === 'video/mp4' || f.type === 'video/webm') return f.size <= MOTION_MAX_BYTES ? null : 'A profile clip must be 8 MB or smaller.'
  if (f.type === 'image/gif') return f.size <= MOTION_MAX_BYTES ? null : 'A GIF profile picture must be 8 MB or smaller.'
  const c = validateMedia(f)
  return c.ok && c.type === 'image' ? null : 'Choose a JPG, PNG, WebP or GIF image, or an MP4/WebM clip of about 5 seconds.'
}

/* ------------------------------------------------------------- motion profile picture */
export const MOTION_MAX_SECONDS = 6          // "about 5 seconds", with a little slack
export const MOTION_MAX_BYTES = 8 * 1024 * 1024

/** Reads a short clip: its length, and a square still taken near the start (the picture shown everywhere else). */
export async function readClip(file: File): Promise<{ seconds: number; poster: File }> {
  const url = URL.createObjectURL(file)
  try {
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url
    await new Promise<void>((ok, bad) => { v.onloadeddata = () => ok(); v.onerror = () => bad(new Error('That clip could not be read. Try an MP4 or WebM.')) })
    const seconds = v.duration
    if (!Number.isFinite(seconds)) throw new Error('That clip could not be read. Try an MP4 or WebM.')
    v.currentTime = Math.min(0.2, seconds / 2)
    await new Promise<void>(ok => { v.onseeked = () => ok(); setTimeout(ok, 1500) })
    const size = 640, c = document.createElement('canvas'); c.width = c.height = size
    const g = c.getContext('2d')!
    const side = Math.min(v.videoWidth, v.videoHeight)
    g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size)
    const blob: Blob = await new Promise((ok, bad) => c.toBlob(b => (b ? ok(b) : bad(new Error('Could not take a picture from the clip.'))), 'image/jpeg', 0.88))
    return { seconds, poster: new File([blob], 'profile.jpg', { type: 'image/jpeg' }) }
  } finally { URL.revokeObjectURL(url) }
}

/** Uploads a short clip and its still, and points the profile at both in one update; the previous files are removed. */
export async function saveMotionAvatar(uid: string, clip: File, poster: File, old: { avatar?: string | null; motion?: string | null }) {
  if (clip.type !== 'video/mp4' && clip.type !== 'video/webm') throw new Error('Use an MP4 or WebM clip (or a GIF).')
  if (clip.size > MOTION_MAX_BYTES) throw new Error('A profile clip must be 8 MB or smaller.')
  const [still, motion] = [await uploadMedia(uid, poster), await uploadMedia(uid, clip)]
  const { error } = await supabase.from('profiles').update({ avatar_path: still.path, avatar_motion_path: motion.path }).eq('id', uid)
  if (error) { await supabase.storage.from('media').remove([still.path, motion.path]); throw error }
  learnAvatar(uid, still.path, old.avatar)
  const drop = [old.avatar, old.motion].filter((x): x is string => Boolean(x) && x !== still.path && x !== motion.path)
  if (drop.length) await supabase.storage.from('media').remove(drop)
  return { avatar: still.path, motion: motion.path }
}

/** Uploads an (already cropped) cover photo and points the profile at it; the previous cover file is removed. */
export async function saveCover(uid: string, file: File, oldPath?: string | null) {
  const c = validateMedia(file)
  if (!c.ok || c.type !== 'image') throw new Error('Choose a JPG, PNG or WebP image under 25 MB.')
  const up = await uploadMedia(uid, file)
  const { error } = await supabase.from('profiles').update({ cover_path: up.path }).eq('id', uid)
  if (error) { await supabase.storage.from('media').remove([up.path]); throw error }
  if (oldPath && oldPath !== up.path) await supabase.storage.from('media').remove([oldPath])
  return up.path
}
