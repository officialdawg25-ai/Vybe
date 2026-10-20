import { supabase } from './supabase'
import { uploadMedia, validateMedia } from './media'

/** Uploads an (already cropped) avatar, points the profile at it, and removes the previous file. */
export async function saveAvatar(uid: string, file: File, oldPath?: string | null) {
  const c = validateMedia(file)
  if (!c.ok || c.type !== 'image') throw new Error('Choose a JPG, PNG or WebP image under 10 MB.')
  const up = await uploadMedia(uid, file)
  const { error } = await supabase.from('profiles').update({ avatar_path: up.path }).eq('id', uid)
  if (error) { await supabase.storage.from('media').remove([up.path]); throw error }
  if (oldPath && oldPath !== up.path) await supabase.storage.from('media').remove([oldPath])
  return up.path
}

/** First-pass check for the file picker (before the cropper opens). */
export function checkAvatarFile(f: File): string | null {
  const c = validateMedia(f)
  return c.ok && c.type === 'image' ? null : 'Choose a JPG, PNG, WebP or GIF image under 10 MB.'
}

/** Uploads an (already cropped) cover photo and points the profile at it; the previous cover file is removed. */
export async function saveCover(uid: string, file: File, oldPath?: string | null) {
  const c = validateMedia(file)
  if (!c.ok || c.type !== 'image') throw new Error('Choose a JPG, PNG or WebP image under 10 MB.')
  const up = await uploadMedia(uid, file)
  const { error } = await supabase.from('profiles').update({ cover_path: up.path }).eq('id', uid)
  if (error) { await supabase.storage.from('media').remove([up.path]); throw error }
  if (oldPath && oldPath !== up.path) await supabase.storage.from('media').remove([oldPath])
  return up.path
}
