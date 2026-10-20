import { supabase } from './supabase'
import { isMissingSchema } from './tickets'

const BASE_KEYS = new Set(['display_name', 'bio', 'interests', 'location', 'dm_policy', 'notif_prefs', 'onboarded_at', 'avatar_path'])

/**
 * Updates the profile. Newer columns (intents, city coordinates, onboarding step) come from a later migration; if the
 * database does not have them yet, the update retries with the columns it does have so onboarding never dead-ends.
 */
export async function updateProfile(uid: string, patch: Record<string, unknown>) {
  const first = await supabase.from('profiles').update(patch).eq('id', uid)
  if (!first.error || !isMissingSchema(first.error)) { if (first.error) throw first.error; return }
  const base = Object.fromEntries(Object.entries(patch).filter(([k]) => BASE_KEYS.has(k)))
  if (!Object.keys(base).length) return
  const retry = await supabase.from('profiles').update(base).eq('id', uid)
  if (retry.error) throw retry.error
}

/** Saves private onboarding facts (birth date, consent). Silently skipped when that table is not deployed yet. */
export async function savePrivate(uid: string, row: { birth_date: string; terms_accepted_at: string }) {
  const { error } = await supabase.from('profile_private').upsert({ user_id: uid, ...row }, { onConflict: 'user_id' })
  if (error && !isMissingSchema(error)) throw error
}
