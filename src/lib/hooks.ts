import { useCallback, useEffect, useRef, useState } from 'react'
import { errMsg } from '../ui'

/** Run an async loader; exposes loading/error/reload and ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const run = useCallback(() => {
    const id = ++seq.current
    setLoading(true)
    fn().then(
      d => { if (id === seq.current) { setData(d); setError(null); setLoading(false) } },
      e => { if (id === seq.current) { setError(errMsg(e)); setLoading(false) } },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(run, [run])
  return { data, setData, error, loading, reload: run }
}

/** Prevents double submits: returns [busy, wrapped]. */
export function useSubmit() {
  const [busy, setBusy] = useState(false)
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return
    setBusy(true)
    try { return await fn() } finally { setBusy(false) }
  }
  return [busy, run] as const
}
