import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'vybe:theme'
const COLORS = { light: '#fafafb', dark: '#0d0d12' }

export function readTheme(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system' } catch { return 'system' }
}

/** Applies the preference to <html data-theme> (absent = follow the OS) and the browser's theme-color. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement
  if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref)
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? COLORS.dark : COLORS.light)
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readTheme)
  useEffect(() => {
    applyTheme(pref)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onOs = () => pref === 'system' && applyTheme('system')
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setPref(readTheme()) } // other tabs stay in sync
    mq.addEventListener('change', onOs); window.addEventListener('storage', onStorage)
    return () => { mq.removeEventListener('change', onOs); window.removeEventListener('storage', onStorage) }
  }, [pref])
  const set = useCallback((p: ThemePref) => {
    try { p === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p) } catch { /* storage unavailable */ }
    setPref(p)
  }, [])
  return [pref, set] as const
}
