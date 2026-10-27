import { Emoji } from '../Emoji'
import { useEffect, useState } from 'react'
import { CalendarPlus, Share2, UserPlus } from 'lucide-react'
import { Avatar } from '../../ui'
import type { Social } from '../../lib/discover'

type Status = 'going' | 'maybe' | 'declined'
type Vis = 'public' | 'friends' | 'private'

function until(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return null
  const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

const CHOICES: { s: Status; emoji: string; label: string; done: string }[] = [
  { s: 'going', emoji: '🔥', label: 'I’m going', done: 'You’re going!' },
  { s: 'maybe', emoji: '👀', label: 'Interested', done: 'Interested' },
  { s: 'declined', emoji: '🙅', label: 'Can’t go', done: 'Not this time' },
]

/**
 * "Are you going?" as something you want to tap: the crowd you'd join (friends first, as far as each person allows),
 * a live countdown, three big reactions with a burst when you commit, and the next things to do once you're in.
 */
export function RsvpPanel({ status, visibility, startsAt, going, interested, people, full, busy, invited, onRsvp, onVisibility, onWho, onInvite, onCalendar, onShare }: {
  status?: string; visibility: Vis; startsAt: string; going: number; interested: number; people: Social['people']; full: boolean; busy: boolean; invited: boolean
  onRsvp: (s: Status) => void; onVisibility: (v: Vis) => void; onWho: () => void; onInvite?: () => void; onCalendar: () => void; onShare: () => void
}) {
  const [now, setNow] = useState(Date.now())
  const [burst, setBurst] = useState(0)
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t) }, [])
  const left = until(startsAt, now)
  const crowd = people.filter(p => p.status === 'going').sort((a, b) => Number(b.friend) - Number(a.friend))
  const friends = crowd.filter(p => p.friend)
  const faces = crowd.slice(0, 5)
  const lead = friends.length ? friends.slice(0, 2).map(p => (p.display_name || p.username).split(' ')[0]).join(', ') + (going > 2 ? ` and ${going - Math.min(2, friends.length)} others` : '') + ' are going'
    : going ? `${going} ${going === 1 ? 'person is' : 'people are'} going` : 'Be the first to say you’re going'
  const tap = (s: Status) => { if (s === 'going' && status !== 'going') setBurst(b => b + 1); onRsvp(s) }
  return (
    <section className="rsvp" aria-labelledby="att-h">
      <div className="rsvp-top">
        <h2 id="att-h" className="rsvp-h">{status === 'going' ? 'You’re in 🎉' : invited ? 'You’re invited!' : 'Are you going?'}</h2>
        {left && <span className="rsvp-count" aria-label={`Starts in ${left}`}>⏳ {left}</span>}
      </div>
      <button className="rsvp-crowd" onClick={onWho} aria-haspopup="dialog" aria-label={`See who’s going: ${going} going${interested ? `, ${interested} interested` : ''}`}>
        <span className="rsvp-faces">{faces.map(p => <Avatar key={p.id} size="sm" path={p.avatar_path} uid={p.id} name={p.display_name || p.username} />)}{going > faces.length && faces.length > 0 && <span className="rsvp-more">+{going - faces.length}</span>}</span>
        <span className="grow"><b>{lead}</b><span className="t-meta">{interested ? `${interested} interested · ` : ''}See who’s going</span></span>
      </button>
      <div className="rsvp-choices" role="group" aria-label="Your attendance">
        {CHOICES.map(c => {
          const on = status === c.s, dis = busy || (c.s === 'going' && full && !on)
          return (
            <button key={c.s} className={`rsvp-btn rsvp-${c.s}${on ? ' on' : ''}`} aria-pressed={on} disabled={dis} onClick={() => tap(c.s)}>
              <span className="rsvp-emoji" aria-hidden><Emoji k={c.emoji} size="1.5rem" idle={on} /></span>
              <span>{c.s === 'going' && full && !on ? 'Full' : on ? c.done : c.label}</span>
              {c.s === 'going' && burst > 0 && <span key={burst} className="rsvp-burst" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ['--a' as string]: `${i * 30}deg` }} />)}</span>}
            </button>)
        })}
      </div>
      {(status === 'going' || status === 'maybe') && (
        <div className="rsvp-next">
          <button className="chip" onClick={onCalendar}><CalendarPlus size={14} aria-hidden /> Add to calendar</button>
          <button className="chip" onClick={onShare}><Share2 size={14} aria-hidden /> Tell friends</button>
          {onInvite && <button className="chip" onClick={onInvite}><UserPlus size={14} aria-hidden /> Invite</button>}
          <label className="rsvp-vis">Visible to
            <select className="select" value={visibility} disabled={busy} onChange={x => onVisibility(x.target.value as Vis)} aria-label="Who can see that you are going">
              <option value="friends">Friends</option><option value="public">Everyone</option><option value="private">Only me and the host</option>
            </select>
          </label>
        </div>
      )}
      <p className="t-meta rsvp-note">Going isn’t a ticket: if this plan sells tickets you still need one to get in.</p>
    </section>
  )
}
