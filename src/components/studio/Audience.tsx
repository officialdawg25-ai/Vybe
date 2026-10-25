import { useMemo, useState } from 'react'
import { ChevronDown, Globe, Search, Sparkles, Star, Users } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { friendIds } from '../../lib/posts'
import { closeFriendIds, setCloseFriend } from '../../lib/studio'
import { useAsync } from '../../lib/hooks'
import { supabase } from '../../lib/supabase'
import { Avatar, Spinner, errMsg, toast } from '../../ui'
import type { PublicProfile } from '../../lib/types'
import { StudioSheet } from './Overlays'

export type Audience = 'public' | 'friends' | 'close_friends'

/** The share sheet: your memory (everyone or friends), Close Friends, keep as a highlight, then Share. */
export function ShareSheet({ audience, story, onAudience, onStory, highlight, onHighlight, preview, busy, onShare, onClose }: {
  audience: Audience; story: 'public' | 'friends'; onAudience: (a: Audience) => void; onStory: (s: 'public' | 'friends') => void
  highlight: boolean; onHighlight: (on: boolean) => void; preview?: React.ReactNode; busy: boolean; onShare: () => void; onClose: () => void
}) {
  const { profile } = useAuth()
  const [opts, setOpts] = useState(false)
  const [list, setList] = useState(false)
  const { n: close, reload } = useCloseCount()
  return (
    <>
      <div className="shs" role="dialog" aria-modal="true" aria-label="Share">
        <div className="shs-preview" onClick={onClose}>{preview}</div>
        <div className="shs-panel">
          <div className="ms-grab" aria-hidden />
          <h2 className="ss-title">Share</h2>
          <div className="shs-rows" role="radiogroup" aria-label="Who sees it">
            <div className="shs-row">
              <Avatar size="lg" path={profile?.avatar_path} name={profile?.display_name || profile?.username || 'You'} />
              <span className="grow">
                <b>Your memory</b>
                <button className="shs-sub" aria-expanded={opts} onClick={() => setOpts(o => !o)}>{story === 'public' ? 'Everyone on VYBE' : 'Friends only'} <ChevronDown size={16} aria-hidden /></button>
              </span>
              <button role="radio" aria-checked={audience !== 'close_friends'} aria-label="Share to your memory" className={`shs-radio${audience !== 'close_friends' ? ' on' : ''}`} onClick={() => onAudience(story)} />
            </div>
            {opts && (
              <div className="shs-opts" role="group" aria-label="Sharing options">
                <button className={story === 'public' ? 'on' : ''} aria-pressed={story === 'public'} onClick={() => { onStory('public'); onAudience('public') }}><Globe size={18} aria-hidden /> Everyone on VYBE</button>
                <button className={story === 'friends' ? 'on' : ''} aria-pressed={story === 'friends'} onClick={() => { onStory('friends'); onAudience('friends') }}><Users size={18} aria-hidden /> Friends only</button>
              </div>
            )}
            <div className="shs-row">
              <span className="cf-badge lg" aria-hidden><Star size={22} fill="currentColor" /></span>
              <span className="grow">
                <b>Close Friends</b>
                <button className="shs-sub" onClick={() => setList(true)}>{close == null ? 'Add people' : close ? `${close} ${close === 1 ? 'person' : 'people'}` : 'Add people'} <ChevronDown size={16} aria-hidden /></button>
              </span>
              <button role="radio" aria-checked={audience === 'close_friends'} aria-label="Share to Close Friends" className={`shs-radio${audience === 'close_friends' ? ' on' : ''}`} onClick={() => (close ? onAudience('close_friends') : setList(true))} />
            </div>
            <label className="shs-row">
              <span className="shs-ico" aria-hidden><Sparkles size={22} /></span>
              <span className="grow"><b>Keep as a highlight</b><span className="shs-note">Stays on your profile after 24 hours</span></span>
              <input type="checkbox" className="shs-switch" checked={highlight} onChange={e => onHighlight(e.target.checked)} />
            </label>
          </div>
          <button className="shs-go" disabled={busy} onClick={onShare}>{busy ? 'Sharing…' : 'Share'}</button>
        </div>
      </div>
      {list && <CloseFriendsSheet onClose={() => { setList(false); reload() }} onSaved={n => { if (n > 0) onAudience('close_friends') }} />}
    </>
  )
}

/** How many people are on my list (null while loading or before migration 26). */
function useCloseCount() {
  const { uid } = useAuth()
  const r = useAsync(async () => (await closeFriendIds(uid!).catch(() => null))?.size ?? null, [uid])
  return { n: r.data ?? null, reload: r.reload }
}

/** Your Close Friends list: friends you choose. Only you see it; nobody is told when you add or remove them. */
export function CloseFriendsSheet({ onClose, onSaved }: { onClose: () => void; onSaved?: (n: number) => void }) {
  const { uid } = useAuth()
  const [q, setQ] = useState('')
  const data = useAsync(async () => {
    const [ids, on] = await Promise.all([friendIds(uid!), closeFriendIds(uid!)])
    if (on === null) return null
    if (!ids.length) return { people: [] as PublicProfile[], on }
    const { data: ps, error } = await supabase.from('profiles').select('id,username,display_name,avatar_path').in('id', ids.slice(0, 500))
    if (error) throw error
    return { people: ((ps ?? []) as PublicProfile[]).sort((a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username)), on }
  }, [uid])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const isOn = (id: string) => picked[id] ?? data.data?.on.has(id) ?? false
  const count = useMemo(() => (data.data ? data.data.people.filter(p => isOn(p.id)).length : 0), [data.data, picked]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (data.data?.people ?? []).filter(p => `${p.display_name} ${p.username}`.toLowerCase().includes(q.trim().toLowerCase()))
  const toggle = async (p: PublicProfile) => {
    const next = !isOn(p.id); setPicked(s => ({ ...s, [p.id]: next }))
    try { await setCloseFriend(uid!, p.id, next) } catch (e) { setPicked(s => ({ ...s, [p.id]: !next })); toast(errMsg(e)) }
  }
  return (
    <StudioSheet title="Close Friends" onClose={() => { onSaved?.(count); onClose() }} wide>
      <p className="ms-fine" style={{ padding: '0 4px 10px' }}>Only you can see your list. Nobody is notified when you add or remove them. {count > 0 && <b>{count} on your list</b>}</p>
      <label className="ms-search"><Search size={20} aria-hidden /><input type="search" aria-label="Search friends" placeholder="Search friends" value={q} onChange={e => setQ(e.target.value)} /></label>
      {data.loading && !data.data ? <Spinner /> : data.error ? <p className="error" role="alert">{data.error}</p> : data.data === null ? <p className="ms-fine">Close Friends needs the latest database update.</p>
        : !data.data?.people.length ? <p className="ms-fine" style={{ padding: 12 }}>Add friends first, then pick your close friends here.</p> : (
          <ul className="ms-list">{shown.map(p => (
            <li key={p.id}><label className="ms-person">
              <Avatar path={p.avatar_path} name={p.display_name || p.username} />
              <span className="grow"><b className="clamp-1">{p.display_name || p.username}</b><span className="clamp-1">@{p.username}</span></span>
              <input type="checkbox" className="cf-check" checked={isOn(p.id)} onChange={() => void toggle(p)} aria-label={`${isOn(p.id) ? 'Remove' : 'Add'} ${p.display_name || p.username}`} />
            </label></li>))}</ul>
        )}
      <button className="shs-go" onClick={() => { onSaved?.(count); onClose() }}>Done</button>
    </StudioSheet>
  )
}
