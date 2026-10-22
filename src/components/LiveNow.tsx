import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Radio } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { Avatar, Field, Sheet, errMsg } from '../ui'

interface Row { id: string; host: string; title: string; event_id: string | null; profiles: { username: string; display_name: string; avatar_path: string | null } }

/**
 * "Live now" on Home: everyone you can see who is broadcasting right now (Row Level Security decides who that is: public
 * streams, and friends-only ones from friends). Updates by itself when someone starts or ends. Hidden when nobody is live.
 */
export function LiveNow() {
  const { uid } = useAuth()
  const list = useAsync(async () => {
    const { data, error } = await supabase.from('live_streams').select('id,host,title,event_id,profiles:host(username,display_name,avatar_path)').eq('status', 'live').order('started_at', { ascending: false }).limit(20)
    if (error) return [] as Row[]
    return (data ?? []) as unknown as Row[]
  }, [uid])
  useEffect(() => {
    const ch = supabase.channel('home-live').on('postgres_changes', { event: '*', schema: 'public', table: 'live_streams' }, () => list.reload()).subscribe()
    return () => { void supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const rows = list.data ?? []
  if (!rows.length) return null
  return (
    <section className="livenow" aria-label="Live now">
      <h2 className="livenow-h"><span className="livenow-dot" aria-hidden /> Live now</h2>
      <ul className="livenow-list">
        {rows.map(s => (
          <li key={s.id}>
            <Link to={s.host === uid ? `/app/live/${s.id}/host` : `/app/live/${s.id}`} className="livenow-item" aria-label={`${s.profiles.display_name || s.profiles.username} is live: ${s.title}. ${s.host === uid ? 'Back to your stream' : 'Watch'}`}>
              <span className="livenow-ring"><Avatar path={s.profiles.avatar_path} uid={s.host} name={s.profiles.display_name || s.profiles.username} size="lg" /><span className="livenow-tag">LIVE</span></span>
              <span className="livenow-name clamp-1">{s.host === uid ? 'You' : s.profiles.display_name || s.profiles.username}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Start broadcasting right away: a title and who can watch, then straight to the camera. Friends and followers are told. */
export function GoLiveSheet({ onClose }: { onClose: () => void }) {
  const { uid, profile } = useAuth()
  const nav = useNavigate()
  const [title, setTitle] = useState(profile?.display_name || profile?.username ? `${profile?.display_name || profile?.username} is live` : 'I’m live')
  const [visibility, setVisibility] = useState<'public' | 'friends'>('public')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (title.trim().length < 2) return setErr('Give your stream a title.')
    setBusy(true); setErr('')
    const { data, error } = await supabase.from('live_streams').insert({ host: uid, title: title.trim().slice(0, 120), visibility }).select('id').single()
    setBusy(false)
    if (error) return setErr(errMsg(error))
    onClose(); nav(`/app/live/${data.id}/host`)
  }
  return (
    <Sheet title="Go live" onClose={onClose}>
      <Field id="gl-title" label="What’s happening?"><input id="gl-title" className="input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="field"><span className="t-name">Who can watch</span>
        <div className="chips" role="group" aria-label="Who can watch">
          <button type="button" className="chip" aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}>Everyone</button>
          <button type="button" className="chip" aria-pressed={visibility === 'friends'} onClick={() => setVisibility('friends')}>Friends only</button>
        </div>
      </div>
      <p className="t-meta" style={{ marginBottom: 12 }}>{visibility === 'public' ? 'Your friends and followers get a notification when you start.' : 'Your friends get a notification when you start.'} You check your camera before anyone sees you.</p>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void go()}><Radio size={16} aria-hidden /> Continue</button></div>
    </Sheet>
  )
}
