import { supabase } from './supabase'
import { uploadMedia, validateMedia } from './media'
import { isMissingSchema } from './tickets'

/** Uploads a (cropped) cover or picture for a community and points the community at it; the previous file is removed.
 *  Only the owner and admins can do this (row security on communities). */
export async function saveCommunityImage(communityId: string, uid: string, file: File, kind: 'cover' | 'avatar', old?: string | null) {
  const c = validateMedia(file)
  if (!c.ok || c.type !== 'image') throw new Error('Choose a JPG, PNG or WebP image.')
  const up = await uploadMedia(uid, file)
  const col = kind === 'cover' ? 'cover_path' : 'avatar_path'
  const { error } = await supabase.from('communities').update({ [col]: up.path }).eq('id', communityId)
  if (error) {
    await supabase.storage.from('media').remove([up.path])
    throw new Error(isMissingSchema(error) ? 'Community pictures need the latest VYBE update on the server.' : error.message)
  }
  if (old && old !== up.path) await supabase.storage.from('media').remove([old])
  return up.path
}
