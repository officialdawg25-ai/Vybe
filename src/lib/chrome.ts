import { useEffect } from 'react'

/** Hides the app's top bar on phones for screens that bring their own (profile, chat, people). The tab bar stays. */
export function useChromeless(on = true) {
  useEffect(() => {
    if (!on) return
    document.documentElement.classList.add('chromeless')
    return () => document.documentElement.classList.remove('chromeless')
  }, [on])
}
