import { supabase } from './supabase'
import { detachTab, slotShared } from './slot'

/**
 * Signs out of this tab only. When another open tab is signed in through the same account slot, this tab moves to a fresh
 * slot instead, so the other tab stays signed in. Otherwise the session is ended on this device (other devices unaffected).
 * Returns false when the page is reloading.
 */
export async function signOutThisTab(): Promise<boolean> {
  if (slotShared()) { detachTab('/signin'); return false }
  await supabase.auth.signOut({ scope: 'local' })
  return true
}
