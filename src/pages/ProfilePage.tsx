import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { loadRelations } from '../lib/friends'
import { fetchPosts } from '../lib/posts'
import { FriendButton } from '../components/FriendButton'
import { Feed } from '../components/Feed'
import { ReportSheet } from '../components/Report'
import { Avatar, Empty, ErrorState, Spinner, errMsg, toast } from '../ui'
import type { Profile } from '../lib/types'

export default function ProfilePage() {
  const { username } = useParams()
  const { uid } = useAuth()
  const nav = useNavigate()
  const [report, setReport] = useState(false)
  const prof = useAsync(async () => {
    const { data, error } = await supabase.from('profiles').select('id,username,display_name,bio,avatar_path,location,interests,dm_policy').eq('username', (username ?? '').toLowerCase()).maybeSingle()
    if (error) throw error
    return data as Profile | null
  }, [username])
  const rel = useAsync(async () => (await loadRelations(uid!)).get(prof.data?.id ?? ''), [uid, prof.data?.id])
  useEffect(() => { document.title = prof.data ? `${prof.data.display_name || prof.data.username} · VYBE` : 'Profile · VYBE' }, [prof.data])

  if (prof.loading) return <Spinner />
  if (prof.error) return <ErrorState message={prof.error} onRetry={prof.reload} />
  const p = prof.data
  if (!p) return <Empty title="Profile not found">This person doesn't exist or isn't available to you.</Empty>
  const mine = p.id === uid

  const message = async () => {
    const { data, error } = await supabase.rpc('start_dm', { other: p.id })
    if (error) return toast(errMsg(error))
    nav(`/app/messages/${data}`)
  }
  const block = async () => {
    if (!confirm(`Block @${p.username}? They won't be able to see your content or message you.`)) return
    const { error } = await supabase.from('blocks').insert({ blocker: uid, blocked: p.id })
    if (error) return toast(errMsg(error))
    toast('Blocked'); nav('/app', { replace: true })
  }

  return (
    <>
      <header className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <Avatar size="lg" path={p.avatar_path} name={p.display_name || p.username} />
        <div className="grow stack" style={{ gap: 6 }}>
          <div><h1 className="t-title">{p.display_name || p.username}</h1><p className="t-meta">@{p.username}{p.location ? ` · ${p.location}` : ''}</p></div>
          {p.bio && <p style={{ whiteSpace: 'pre-wrap' }}>{p.bio}</p>}
          {p.interests.length > 0 && <div className="chips">{p.interests.map(i => <span key={i} className="chip on" style={{ cursor: 'default' }}>{i}</span>)}</div>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {mine ? <Link className="btn sm" to="/app/settings">Edit profile</Link> : <>
              <FriendButton other={p.id} rel={rel.data ?? undefined} onChanged={rel.reload} />
              <button className="btn sm" onClick={message}>Message</button>
              <button className="btn ghost sm" onClick={() => setReport(true)}>Report</button>
              <button className="btn ghost sm danger" onClick={block}>Block</button>
            </>}
          </div>
        </div>
      </header>
      <h2 className="t-section" style={{ margin: '24px 0 4px' }}>Posts</h2>
      <Feed load={c => fetchPosts({ uid: uid!, cursor: c, author: p.id })} deps={[p.id]} empty={{ title: 'No posts to show', text: mine ? 'Share your first post from Discover.' : 'Nothing visible to you yet.' }} />
      {report && <ReportSheet target={{ type: 'profile', id: p.id }} onClose={() => setReport(false)} />}
    </>
  )
}
