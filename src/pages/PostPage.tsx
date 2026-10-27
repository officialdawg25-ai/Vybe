import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { withPostSelect } from '../lib/posts'
import type { Post } from '../lib/types'
import { PostCard } from '../components/PostCard'
import { Comments } from '../components/Comments'
import { Empty, ErrorState, Spinner } from '../ui'

export default function PostPage() {
  const { id } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const { data, setData, error, loading, reload } = useAsync(async () => {
    const { data, error } = await withPostSelect(sel => supabase.from('posts').select(sel).eq('id', id!).eq('mine_reaction.user_id', uid!).maybeSingle())
    if (error) throw error
    return data as unknown as Post | null
  }, [id])
  return (
    <>
      <h1 className="sr-only">Post</h1>
      <button className="btn ghost sm" onClick={() => nav(-1)}><ArrowLeft size={18} aria-hidden /> Back</button>
      {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={reload} />
        : !data ? <Empty title="Post not found">It may have been deleted, or you may not have permission to see it.</Empty>
        : <>
          <PostCard post={data} onChange={setData} onDeleted={() => nav('/app', { replace: true })} />
          <Comments postId={data.id} postAuthor={data.author} dock off={Boolean(data.comments_off)} />
        </>}
    </>
  )
}
