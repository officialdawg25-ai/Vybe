import { useEffect, useState } from 'react'

/**
 * Pictures that are decoded once and then remembered for the session, so a card that scrolls away and back, or a screen you
 * return to, paints its artwork on the first frame instead of fading in again. `preload` can be called ahead of time.
 */
const ready = new Set<string>()
const pending = new Map<string, Promise<boolean>>()

export const isReady = (url?: string | null) => Boolean(url && ready.has(url))

export function preload(url?: string | null): Promise<boolean> {
  if (!url) return Promise.resolve(false)
  if (ready.has(url)) return Promise.resolve(true)
  let p = pending.get(url)
  if (!p) {
    p = new Promise<boolean>(resolve => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => { void (img.decode ? img.decode().catch(() => undefined) : Promise.resolve()).then(() => { ready.add(url); pending.delete(url); resolve(true) }) }
      img.onerror = () => { pending.delete(url); resolve(false) }
      img.src = url
    })
    pending.set(url, p)
  }
  return p
}

/** True once the picture is decoded (immediately when it already was). Use it to show artwork only when it can paint at once. */
export function useReadyImage(url?: string | null): boolean {
  const [ok, setOk] = useState(() => isReady(url))
  useEffect(() => {
    if (!url) { setOk(false); return }
    if (isReady(url)) { setOk(true); return }
    let live = true
    setOk(false)
    void preload(url).then(r => { if (live) setOk(r) })
    return () => { live = false }
  }, [url])
  return ok
}

/** Inline style for an artwork background: the picture only once decoded; `.art-in` fades it in the first time. */
export function artStyle(url: string | null | undefined, ok: boolean): { backgroundImage?: string } | undefined {
  return url && ok ? { backgroundImage: `url(${url})` } : undefined
}
