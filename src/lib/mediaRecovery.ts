import { useEffect, useRef, useState } from 'react'

/**
 * Recovery for one video element, so nothing stays stuck or broken without a way out:
 *  - an error while online first asks for a fresh signed address once, silently (the usual cause is an expired link);
 *    a second error in a row shows the error state with Retry;
 *  - an error while offline shows "You're offline" and retries by itself when the connection comes back;
 *  - a video that should be playing but has shown no frame after SLOW_MS shows a non-blocking "taking longer" hint
 *    with Retry (the element keeps loading meanwhile).
 * `refresh` re-signs the address (useSignedState().refresh); a successful 'playing' resets the counters. `attempt` changes
 * on every retry: use it as the video element's key so it reloads even when the new address happens to be identical.
 */
export const SLOW_MS = 12_000
export type MediaProblem = null | 'offline' | 'error'

export function useVideoRecovery(refresh: () => void, opts: { wanted: boolean; src: string | null }) {
  const [problem, setProblem] = useState<MediaProblem>(null)
  const [slow, setSlow] = useState(false)
  const silentTries = useRef(0)
  const started = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const doRefresh = useRef(refresh); doRefresh.current = refresh

  const retry = () => { setProblem(null); setSlow(false); started.current = false; setAttempt(a => a + 1); doRefresh.current() }
  const onError = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setProblem('offline'); return }
    if (silentTries.current < 1) { silentTries.current += 1; setAttempt(a => a + 1); doRefresh.current(); return }
    setProblem('error')
  }
  const onPlaying = () => { started.current = true; silentTries.current = 0; setSlow(false); setProblem(null) }

  // Back online after an offline failure: try again by itself.
  useEffect(() => {
    if (problem !== 'offline') return
    const on = () => retry()
    window.addEventListener('online', on); return () => window.removeEventListener('online', on)
  }, [problem]) // eslint-disable-line react-hooks/exhaustive-deps
  // A wanted video with no first frame after SLOW_MS: say so (never an endless spinner).
  useEffect(() => {
    setSlow(false)
    if (!opts.wanted || !opts.src || started.current || problem) return
    const t = window.setTimeout(() => { if (!started.current) setSlow(true) }, SLOW_MS)
    return () => window.clearTimeout(t)
  }, [opts.wanted, opts.src, problem])

  // Where the video was, so a reload after an error continues from there instead of the start.
  const last = useRef(0)
  const mark = (t: number) => { if (t > 0) last.current = t }
  const resumeAt = attempt > 0 ? last.current : 0

  // The address an element plays from stays fixed until a retry: the hourly re-sign of a cached link must not reload a
  // video in the middle of playback (an expired link then fails a later range request, which retries from `resumeAt`).
  const pinned = useRef<{ attempt: number; src: string | null }>({ attempt, src: opts.src })
  if (pinned.current.attempt !== attempt || !pinned.current.src) pinned.current = { attempt, src: opts.src }

  return { problem, slow, attempt, src: pinned.current.src, resumeAt, mark, retry, onError, onPlaying }
}

export const problemText = (p: MediaProblem) => (p === 'offline' ? 'You’re offline. The video will load when you’re back online.' : 'This video couldn’t be played.')
