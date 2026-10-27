import { supabase } from './supabase'
import { queued, uploadObject } from './upload'
import { discardUploads } from './media'
import { makeSmallCopy } from './videoCopy'

/**
 * After publishing: make the copy, upload it to the author's folder and attach it to the gallery row (migration 35).
 * Best effort and silent. If attaching fails the uploaded copy is deleted again.
 */
export async function attachSmallCopy(uid: string, file: Blob, postId: string, sort: number, signal?: AbortSignal): Promise<string | null> {
  const copy = await makeSmallCopy(file, signal); if (!copy || signal?.aborted) return null
  const path = `${uid}/${crypto.randomUUID()}-480.${copy.ext}`
  try {
    await queued(() => uploadObject({ bucket: 'media', path, file: copy.blob, contentType: copy.blob.type, cacheControl: '31536000', signal }))
    const { error } = await supabase.from('post_media').update({ display_path: path }).eq('post_id', postId).eq('sort', sort)
    if (error) throw error
    return path
  } catch { discardUploads('media', [path]); return null }
}
