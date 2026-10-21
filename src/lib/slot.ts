/**
 * Per-tab account slots. Each browser tab keeps its own signed-in account, so two people (or one person with two
 * accounts) can use VYBE side by side in different tabs without signing each other out.
 *
 *  - The first/main slot uses Supabase's default storage key, so everyone who is already signed in stays signed in.
 *  - "Add another account" opens a tab with ?account=new, which creates a fresh slot (its own storage key).
 *  - A brand-new tab opens as the account used most recently on this device; after that the tab keeps its own slot.
 *  - Every open tab announces which slot it uses (a heartbeat in localStorage). When another open tab shares this tab's
 *    slot, signing out here (or opening the sign-in page here) moves only this tab to a fresh slot, so the other tab
 *    stays signed in and a different account can sign in here. That is what makes two-account testing in two tabs work.
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

// Browsers throttle timers in hidden tabs (down to about once a minute), so a tab counts as open for a generous window;
// tabs that close normally remove themselves straight away (pagehide).
const ALIVE_KEY = 'vybe:tabs', BEAT_MS = 4000, STALE_MS = 150_000
const tabId = Math.random().toString(36).slice(2, 10)
type Beats = Record<string, { slot: string; t: number }>
const readBeats = (): Beats => { try { return JSON.parse(localStorage.getItem(ALIVE_KEY) || '{}') as Beats } catch { return {} } }
const writeBeats = (mutate: (b: Beats) => void) => {
  try {
    const b = readBeats(), now = Date.now()
    for (const k of Object.keys(b)) if (now - b[k].t > STALE_MS) delete b[k]
    mutate(b)
    localStorage.setItem(ALIVE_KEY, JSON.stringify(b))
  } catch { /* storage unavailable: tabs simply share as before */ }
}
let leaving = false
const beat = () => { if (!leaving) writeBeats(b => { b[tabId] = { slot: accountSlot, t: Date.now() } }) }
if (typeof window !== 'undefined') {
  beat()
  window.setInterval(beat, BEAT_MS)
  window.addEventListener('pagehide', () => { leaving = true; writeBeats(b => { delete b[tabId] }) })
  window.addEventListener('pageshow', () => { leaving = false; beat() })
  document.addEventListener('visibilitychange', beat)
}

/** True when another open tab is using this tab's account slot. */
export const slotShared = () => Object.entries(readBeats()).some(([id, x]) => id !== tabId && x.slot === accountSlot && Date.now() - x.t < STALE_MS)

/** Moves this tab (only) to a fresh, signed-out slot and reloads at `to`. Other tabs keep their sessions. */
export function detachTab(to: string) {
  try {
    sessionStorage.setItem(TAB_KEY, `a${crypto.randomUUID().slice(0, 8)}`)
    leaving = true
    writeBeats(b => { delete b[tabId] })
  } catch { /* ignore */ }
  location.replace(to)
}
