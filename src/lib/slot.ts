/**
 * Per-tab account slots. Each browser tab keeps its own signed-in account, so two people (or one person with two
 * accounts) can use VYBE side by side in different tabs without signing each other out.
 *
 *  - The first/main slot uses Supabase's default storage key, so everyone who is already signed in stays signed in.
 *  - "Add another account" opens a tab with ?account=new, which creates a fresh slot (its own storage key).
 *  - A brand-new tab opens as the account used most recently on this device; after that the tab keeps its own slot.
 */
const TAB_KEY = 'vybe:slot', LAST_KEY = 'vybe:slot:last'

function pick(): string {
  try {
    const q = new URLSearchParams(location.search)
    if (q.get('account') === 'new') {
      const id = `a${crypto.randomUUID().slice(0, 8)}`
      sessionStorage.setItem(TAB_KEY, id)
      q.delete('account')
      history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`)
      return id
    }
    const own = sessionStorage.getItem(TAB_KEY)
    if (own && /^[a-z0-9]{1,12}$/i.test(own)) return own
    const last = localStorage.getItem(LAST_KEY)
    const id = last && /^[a-z0-9]{1,12}$/i.test(last) ? last : 'main'
    sessionStorage.setItem(TAB_KEY, id)
    return id
  } catch { return 'main' }
}

export const accountSlot = pick()

/** Storage key for this tab's session; undefined (Supabase's default) for the main slot. */
export const slotStorageKey = (ref: string) => (accountSlot === 'main' ? undefined : `sb-${ref}-auth-${accountSlot}`)

/** Remember this device's most recent account so new tabs open as it. */
export const rememberSlot = () => { try { localStorage.setItem(LAST_KEY, accountSlot) } catch { /* private mode */ } }
