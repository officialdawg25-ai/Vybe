import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Post } from '../lib/types'
import { PAGE } from '../lib/posts'
import { primeSignedUrls } from '../lib/media'
import { PostCard } from './PostCard'
import { Empty, ErrorState, Spinner, errMsg } from '../ui'

/**
 * What this tab showed last time, for this page session only (memory, never storage): coming back to Home shows it at once
 * while the server copy loads, and the server copy always replaces it. A reload starts clean, so stale posts are never
 * replayed as current.
 */
const seen = new Map<string, { posts: Post[]; done: boolean }>()
/** Data-saver users get the "Load more" button only; everyone else gets the next page prepared before reaching the end. */
const saveData = () => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData)

/** Cursor-paginated list. `load(cursor)` returns the next page of posts (newest first). */
export function Feed({ load, deps, prepend, empty, why, cacheKey, refreshEvent }: {
  load: (cursor?: string) => Promise<Post[]>
  deps: unknown[]
  prepend?: Post | null
  empty: { title: string; text: string; action?: ReactNode }
  why?: (p: Post) => string | undefined
  /** Keeps the last result in memory for instant return visits (scoped to the signed-in account and tab). */
  cacheKey?: string
  /** A window event that refreshes the list in place (the VYBE logo sends one on Home). */
  refreshEvent?: string
}) {
  const cached = cacheKey ? seen.get(cacheKey) : undefined
  const [posts, setPosts] = useState<Post[]>(cached?.posts ?? [])
  const [loading, setLoading] = useState(!cached)
  const [more, setMore] = useState(false)
  const [done, setDone] = useState(cached?.done ?? false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)

  const first = useCallback(() => {
    let live = true
    const keep = cacheKey ? seen.get(cacheKey) : undefined
    if (!keep) setLoading(true)
    setError(''); setStale(false)
    load().then(async p => { await primeSignedUrls(p.flatMap(x => [x.media_path, x.profiles.avatar_path])); return p }).then(p => {
      if (!live) return
      setPosts(p); setDone(p.length < PAGE); setLoading(false)
      if (cacheKey) seen.set(cacheKey, { posts: p, done: p.length < PAGE })
    }, e => {
      if (!live) return
      setError(errMsg(e)); setLoading(false)
      if (keep) setStale(true)                       // keep showing what was there; say it may be out of date
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(first, [first])
  useEffect(() => {
    if (!refreshEvent) return
    const f = () => { first() }
    window.addEventListener(refreshEvent, f); return () => window.removeEventListener(refreshEvent, f)
  }, [refreshEvent, first])
  useEffect(() => { if (prepend) setPosts(p => (p.some(x => x.id === prepend.id) ? p : [prepend, ...p])) }, [prepend])
  useEffect(() => { if (cacheKey && posts.length) seen.set(cacheKey, { posts, done }) }, [cacheKey, posts, done])

  const next = async () => {
    if (more || done || !posts.length) return
    setMore(true)
    try {
      const p = await load(posts[posts.length - 1].created_at)
      await primeSignedUrls(p.flatMap(x => [x.media_path, x.profiles.avatar_path]))
      setPosts(cur => [...cur, ...p.filter(n => !cur.some(c => c.id === n.id))])
      setDone(p.length < PAGE)
    } catch (e) { setError(errMsg(e)) } finally { setMore(false) }
  }
  const nextRef = useRef(next); nextRef.current = next
  // Prepare the next page about two screens before the end, so scrolling rarely meets a spinner.
  useEffect(() => {
    const el = sentinel.current
    if (!el || done || saveData() || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) void nextRef.current() }, { rootMargin: '0px 0px 1600px 0px' })
    io.observe(el); return () => io.disconnect()
  }, [done, posts.length, loading])

  if (loading) return <Spinner />
  if (error && !posts.length) return <ErrorState message={error} onRetry={first} />
  if (!posts.length) return <Empty title={empty.title} action={empty.action}>{empty.text}</Empty>
  return (
    <div>
      {posts.map(p => (
        <PostCard key={p.id} post={p} why={why?.(p)}
          onChange={n => setPosts(cur => cur.map(x => (x.id === n.id ? n : x)))}
          onDeleted={id => setPosts(cur => cur.filter(x => x.id !== id))} />
      ))}
      {error && <p className="error" role="alert">{stale ? 'Couldn’t refresh, so this may be out of date. ' : ''}{error} <button className="linklike" onClick={first}>Try again</button></p>}
      {!done && <div ref={sentinel} style={{ textAlign: 'center', padding: 16 }}><button className="btn" onClick={next} disabled={more}>{more ? 'Loading…' : 'Load more'}</button></div>}
    </div>
  )
}
