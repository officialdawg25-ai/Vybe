import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MoreVertical, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { FollowButton } from '../components/discover/FollowButton'
import { NameTick } from '../components/VerifiedBadge'
import { useChromeless } from '../lib/chrome'
import { useAsync } from '../lib/hooks'
import { supabase } from '../lib/supabase'
import { isMissingSchema } from '../lib/tickets'
import { Avatar, Empty, ErrorState, Sheet, Spinner, errMsg, toast } from '../ui'
import type { PublicProfile } from '../lib/types'

export interface Suggestion extends PublicProfile { follows_me: boolean; friend: boolean; mutual: number; shared: string[] }
export async function loadSuggestions(limit = 40): Promise<Suggestion[] | null> {
  const { data, error } = await supabase.rpc('people_suggestions', { p_limit: limit })
  if (error) { if (isMissingSchema(error)) return null; throw error }
  return (Array.isArray(data) ? data : []) as Suggestion[]
}
const reason = (s: Suggestion) => s.follows_me ? 'Follows you' : s.mutual > 0 ? `${s.mutual} mutual ${s.mutual === 1 ? 'friend' : 'friends'}` : s.shared.length ? `Into ${s.shared.slice(0, 2).join(' & ')}` : `@${s.username}`

/** Discover people: full screen, one solid Follow (or Follow back) button per row, ⋮ for more, Done at the bottom. */
export default function People() {
  const nav = useNavigate()
  const { uid } = useAuth()
  useChromeless()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [more, setMore] = useState<Suggestion | null>(null)
  const list = useAsync(() => loadSuggestions(60), [uid])
  useEffect(() => { document.title = 'Discover people · VYBE' }, [])
  const rows = useMemo(() => (list.data ?? []).filter(s => !hidden.has(s.id)), [list.data, hidden])
  const block = async (s: Suggestion) => {
    if (!confirm(`Block @${s.username}?`)) return
    const { error } = await supabase.from('blocks').insert({ blocker: uid, blocked: s.id })
    if (error) return toast(errMsg(error)); setHidden(h => new Set(h).add(s.id)); setMore(null)
  }
  return (
    <main className="ppl">
      <header className="ppl-h"><button className="icon-btn" aria-label="Close" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/app'))}><X size={28} /></button><h1>Discover people</h1></header>
      <div className="ppl-body">
        {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.data === null ? <p className="notice" role="status">People suggestions need the latest update.</p>
          : !rows.length ? <Empty title="You’re all caught up">There’s nobody new to suggest right now. Check back as more people join.</Empty>
          : <ul className="ppl-list">{rows.map(s => (
            <li key={s.id} className="ppl-row">
              <Link to={`/app/u/${s.username}`} className="ppl-link"><Avatar size="lg" path={s.avatar_path} name={s.display_name || s.username} />
                <span className="ppl-text"><span className="ppl-name"><NameTick name={s.display_name || s.username} profile={s} /></span><span className="t-meta clamp-1">{reason(s)}</span></span></Link>
              <FollowButton type="profile" id={s.id} following={false} size="md" idleText={s.follows_me ? 'Follow back' : 'Follow'} label={s.display_name || s.username} className="ppl-follow" />
              <button className="icon-btn" aria-label={`More about ${s.display_name || s.username}`} onClick={() => setMore(s)}><MoreVertical size={20} /></button>
            </li>))}</ul>}
      </div>
      <footer className="ppl-f"><button className="btn primary" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/app'))}>Done</button></footer>
      {more && (
        <Sheet title={more.display_name || more.username} onClose={() => setMore(null)}>
          <div className="stack" style={{ gap: 8 }}>
            <Link className="btn" to={`/app/u/${more.username}`}>View profile</Link>
            <button className="btn" onClick={() => { setHidden(h => new Set(h).add(more.id)); setMore(null) }}>Not interested</button>
            <button className="btn danger" onClick={() => block(more)}>Block</button>
            <button className="btn ghost" onClick={() => setMore(null)}>Close</button>
          </div>
        </Sheet>
      )}
    </main>
  )
}
