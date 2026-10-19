import { useCallback, useEffect, useState } from 'react'
import type { Post } from '../lib/types'
import { PAGE } from '../lib/posts'
import { PostCard } from './PostCard'
import { Empty, ErrorState, Spinner, errMsg } from '../ui'

/** Cursor-paginated list. `load(cursor)` returns the next page of posts (newest first). */
export function Feed({ load, deps, prepend, empty, why }: {
  load: (cursor?: string) => Promise<Post[]>
  deps: unknown[]
  prepend?: Post | null
  empty: { title: string; text: string }
  why?: (p: Post) => string | undefined
}) {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const first = useCallback(() => {
    let live = true
    setLoading(true); setError(''); setDone(false)
    load().then(p => { if (live) { setPosts(p); setDone(p.length < PAGE); setLoading(false) } },
      e => { if (live) { setError(errMsg(e)); setLoading(false) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(first, [first])
  useEffect(() => { if (prepend) setPosts(p => (p.some(x => x.id === prepend.id) ? p : [prepend, ...p])) }, [prepend])

  const next = async () => {
    if (more || !posts.length) return
    setMore(true)
    try {
      const p = await load(posts[posts.length - 1].created_at)
      setPosts(cur => [...cur, ...p.filter(n => !cur.some(c => c.id === n.id))])
      setDone(p.length < PAGE)
    } catch (e) { setError(errMsg(e)) } finally { setMore(false) }
  }

  if (loading) return <Spinner />
  if (error && !posts.length) return <ErrorState message={error} onRetry={first} />
  if (!posts.length) return <Empty title={empty.title}>{empty.text}</Empty>
  return (
    <div>
      {posts.map(p => (
        <PostCard key={p.id} post={p} why={why?.(p)}
          onChange={n => setPosts(cur => cur.map(x => (x.id === n.id ? n : x)))}
          onDeleted={id => setPosts(cur => cur.filter(x => x.id !== id))} />
      ))}
      {error && <p className="error" role="alert">{error}</p>}
      {!done && <div style={{ textAlign: 'center', padding: 16 }}><button className="btn" onClick={next} disabled={more}>{more ? 'Loading…' : 'Load more'}</button></div>}
    </div>
  )
}
