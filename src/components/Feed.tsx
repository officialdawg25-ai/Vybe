import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Post } from '../lib/types'
import { PAGE, cursorOf } from '../lib/posts'
import { primeSignedUrls } from '../lib/media'
import { markFirstPost } from '../lib/metrics'
import { supabase } from '../lib/supabase'
import { appendPage, olderThanPage, pagePaths, prefetchMargin, readFeed, reconcile, withConfirmed, writeFeed } from '../lib/feedCache'
import { PostCard } from './PostCard'
import { Empty, ErrorState, Spinner, errMsg } from '../ui'

/** Of these post ids, the ones the viewer may still see (RLS decides). Null when the check itself failed. */
async function stillVisible(ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set()
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('posts').select('id').in('id', ids.slice(i, i + 100))
    if (error) return null
    for (const r of data ?? []) out.add(r.id as string)
  }
  return out
}

/**
 * Cursor-paginated list. `load(cursor)` returns the next page of posts (newest first).
 *
 * With a `cacheKey`, coming back to the feed shows the last snapshot (and scroll position) immediately and refreshes from the
 * server in the background; the server's answer replaces the snapshot, keeping older posts only if they are still visible.
 * The next page is fetched before you reach the end (less eagerly on data saver). `refreshOn` names a window event that
 * re-checks the server (e.g. tapping the VYBE logo while already on Home). `prepend` is a post the server just confirmed.
 * `after(i)` renders something (a suggestion rail) after the i-th post.
 */
export function Feed({ load, deps, prepend, empty, why, cacheKey, refreshOn, after }: {
  load: (cursor?: string) => Promise<Post[]>
  deps: unknown[]
  prepend?: Post | null
  empty: { title: string; text: string; action?: ReactNode }
  why?: (p: Post) => string | undefined
  cacheKey?: string
  refreshOn?: string
  after?: (index: number) => ReactNode
}) {
  const snap = readFeed(cacheKey)
  const [posts, setPosts] = useState<Post[]>(() => withConfirmed(snap?.posts ?? [], prepend))
  const [loading, setLoading] = useState(!snap)
  const [refreshing, setRefreshing] = useState(false)
  const [more, setMore] = useState(false)
  const [done, setDone] = useState(snap?.done ?? false)
  const [error, setError] = useState('')
  const gen = useRef(0)                       // bumps on every refresh, so a late answer never overwrites a newer one
  const latest = useRef({ posts, done })
  latest.current = { posts, done }
  const confirmed = useRef(prepend)
  confirmed.current = prepend
  const sentinel = useRef<HTMLDivElement>(null)
  const failed = useRef<'first' | 'next'>('first')

  const first = useCallback(() => {
    const id = ++gen.current
    const had = latest.current.posts
    if (had.length) setRefreshing(true); else setLoading(true)
    setError('')
    ;(async () => {
      const fresh = await load()
      // One batched signing call for the page's pictures, started now but not waited for: the posts (text, names,
      // layout) render straight away and each picture picks up its signed address as soon as the batch answers.
      void primeSignedUrls(pagePaths(fresh))
      const recheck = olderThanPage(fresh, had, PAGE)
      const visible = recheck.length ? await stillVisible(recheck) : new Set<string>()
      if (id !== gen.current) return
      const list = withConfirmed(reconcile(fresh, had, visible ?? new Set(), PAGE), confirmed.current)
      setPosts(list)
      setDone(fresh.length < PAGE)
    })().catch(e => { if (id === gen.current) { failed.current = 'first'; setError(errMsg(e)) } })   // keeps whatever is on screen
      .finally(() => { if (id === gen.current) { setLoading(false); setRefreshing(false) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { first(); return () => { gen.current++ } }, [first])
  useEffect(() => { if (prepend) setPosts(p => withConfirmed(p, prepend)) }, [prepend])
  useEffect(() => { if (posts.length) markFirstPost() }, [posts.length])

  // Re-check the server on request (logo tap on Home), without blanking the feed.
  useEffect(() => {
    if (!refreshOn) return
    const on = () => first()
    window.addEventListener(refreshOn, on)
    return () => window.removeEventListener(refreshOn, on)
  }, [refreshOn, first])

  const next = useCallback(async () => {
    const { posts: cur, done: finished } = latest.current
    if (more || finished || !cur.length) return
    const id = gen.current
    setMore(true)
    try {
      const p = await load(cursorOf(cur[cur.length - 1]))
      void primeSignedUrls(pagePaths(p))
      if (id !== gen.current) return
      setPosts(c => appendPage(c, p))
      setDone(p.length < PAGE)
    } catch (e) { if (id === gen.current) { failed.current = 'next'; setError(errMsg(e)) } } finally { setMore(false) }
  }, [load, more])

  // Fetch the next page before the reader gets there.
  useEffect(() => {
    const el = sentinel.current
    if (!el || done || loading || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) void next() }, { rootMargin: prefetchMargin() })
    io.observe(el)
    return () => io.disconnect()
  }, [next, done, loading, posts.length])

  // Remember the feed and where the reader was, and put them back on return.
  useEffect(() => () => writeFeed(cacheKey, { ...latest.current, scrollY: window.scrollY }), [cacheKey])
  useLayoutEffect(() => { if (snap?.scrollY) window.scrollTo(0, snap.scrollY) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Spinner />
  if (error && !posts.length) return <ErrorState message={error} onRetry={first} />
  if (!posts.length) return <Empty title={empty.title} action={empty.action}>{empty.text}</Empty>
  return (
    <div aria-busy={refreshing || undefined}>
      {refreshing && <div className="feed-refresh" role="status">Checking for new posts…</div>}
      {posts.map((p, i) => (
        <Fragment key={p.id}>
          <PostCard post={p} why={why?.(p)}
            onChange={n => setPosts(cur => cur.map(x => (x.id === n.id ? n : x)))}
            onDeleted={id => setPosts(cur => cur.filter(x => x.id !== id))} />
          {after?.(i)}
        </Fragment>
      ))}
      {error && <p className="error" role="alert">{error} <button className="linklike" onClick={() => { setError(''); if (failed.current === 'next') void next(); else first() }}>Try again</button></p>}
      {!done && <div ref={sentinel} style={{ textAlign: 'center', padding: 16 }}><button className="btn" onClick={() => void next()} disabled={more}>{more ? 'Loading…' : 'Load more'}</button></div>}
    </div>
  )
}
