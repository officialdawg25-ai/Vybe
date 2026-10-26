import { useSyncExternalStore } from 'react'
import type { Post } from './types'

/**
 * Facebook-style publishing: tapping Post or Share hands the work to this queue and the member goes straight back to the
 * feed. The upload and the save carry on here (outside any screen, so leaving the composer does not stop them); a slim bar
 * shows progress, then a short "Shared" confirmation. A failure keeps everything in memory so one tap retries it.
 *
 * Nothing is lost silently: closing the tab while something is still publishing asks first.
 */
export type PublishKind = 'post' | 'memory' | 'reel'
export interface PublishJob {
  id: string; kind: PublishKind; label: string; thumb: string | null
  /** 0–1 when known, null while it cannot be measured (the bar then shows motion instead of a number). */
  progress: number | null
  status: 'running' | 'failed' | 'done'; error?: string
}
type Run = (report: (p: number) => void) => Promise<Post | null | void>
interface Entry { job: PublishJob; run: Run; onDiscard?: () => void }

/** Fired with the saved post (detail) when a post or reel is published, so the feed can show it without reloading. */
export const POSTED_EVENT = 'vybe:posted'
/** Fired when a memory is published, so the memory rail refreshes. */
export const MEMORY_POSTED_EVENT = 'vybe:memory-posted'
const DONE_MS = 2600

const entries = new Map<string, Entry>()
let snapshot: PublishJob[] = []
const subs = new Set<() => void>()
const emit = () => { snapshot = [...entries.values()].map(e => e.job); subs.forEach(f => f()) }
const patch = (id: string, p: Partial<PublishJob>) => { const e = entries.get(id); if (e) { e.job = { ...e.job, ...p }; emit() } }

function start(id: string) {
  const e = entries.get(id); if (!e) return
  patch(id, { status: 'running', error: undefined })
  let last = 0
  const report = (p: number) => { const v = Math.max(0, Math.min(1, p)); if (Math.abs(v - last) >= 0.01 || v === 1) { last = v; patch(id, { progress: v }) } }
  e.run(report).then(result => {
    patch(id, { status: 'done', progress: 1 })
    if (e.job.kind === 'memory') window.dispatchEvent(new Event(MEMORY_POSTED_EVENT))
    else if (result) window.dispatchEvent(new CustomEvent<Post>(POSTED_EVENT, { detail: result }))
    setTimeout(() => remove(id), DONE_MS)
  }, err => patch(id, { status: 'failed', error: err instanceof Error ? err.message : String(err ?? 'Something went wrong') }))
}
function remove(id: string) {
  const e = entries.get(id); if (!e) return
  if (e.job.thumb?.startsWith('blob:')) URL.revokeObjectURL(e.job.thumb)
  entries.delete(id); emit()
}

/** Start publishing in the background. `thumb` (an object URL is fine) is shown in the bar and released afterwards. */
export function publish(kind: PublishKind, label: string, thumb: string | null, run: Run, opts: { onDiscard?: () => void } = {}): string {
  const id = crypto.randomUUID()
  entries.set(id, { job: { id, kind, label, thumb, progress: null, status: 'running' }, run, onDiscard: opts.onDiscard })
  emit(); start(id)
  return id
}
export const retryPublish = (id: string) => start(id)
/** Give up on a failed item: whatever it had uploaded is cleaned up by its own `onDiscard`. */
export function discardPublish(id: string) { const e = entries.get(id); if (!e || e.job.status === 'running') return; e.onDiscard?.(); remove(id) }
export const dismissPublish = (id: string) => { const e = entries.get(id); if (e?.job.status === 'done') remove(id) }

export function usePublishing(): PublishJob[] {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => snapshot)
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', e => {
    if (![...entries.values()].some(x => x.job.status === 'running')) return
    e.preventDefault(); e.returnValue = ''
  })
}
