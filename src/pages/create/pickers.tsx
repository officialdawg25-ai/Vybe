import { useEffect, useMemo, useState } from 'react'
import { Check, LocateFixed, MapPin, Pause, Play, Search, Music2 } from 'lucide-react'
import { useAuth } from '../../auth/AuthProvider'
import { friendIds } from '../../lib/posts'
import { searchCities } from '../../lib/cities'
import { locateMe, usePlace } from '../../lib/location'
import { placeDetails, searchPlaces, useMapsConfigured, type Suggestion } from '../../lib/maps'
import { ACTIVITIES, FEELINGS, brandUrl, musicCatalog, setTrackSaved, type Track } from '../../lib/social'
import { useAsync } from '../../lib/hooks'
import { supabase } from '../../lib/supabase'
import { Avatar, Spinner, errMsg, toast } from '../../ui'
import type { PublicProfile } from '../../lib/types'

const SearchBox = ({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) => (
  <label className="cp-search"><Search size={18} aria-hidden /><input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} autoComplete="off" /></label>
)

/* ------------------------------------------------------------------ feelings & activities */
export function FeelingPicker({ value, onPick }: { value: string | null; onPick: (key: string | null) => void }) {
  const [tab, setTab] = useState<'feelings' | 'activities'>('feelings')
  const [q, setQ] = useState('')
  const list = (tab === 'feelings' ? FEELINGS : ACTIVITIES).filter(m => m.label.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="cp-sub">
      <div className="cp-tabs" role="tablist" aria-label="Feelings or activities">
        {(['feelings', 'activities'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={`cp-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>{t === 'feelings' ? 'Feelings' : 'Activities'}</button>)}
      </div>
      <SearchBox value={q} onChange={setQ} placeholder="Search" label="Search feelings and activities" />
      <ul className="cp-grid">
        {list.map(m => (
          <li key={m.key}><button className={`cp-mood${value === m.key ? ' on' : ''}`} aria-pressed={value === m.key} onClick={() => onPick(value === m.key ? null : m.key)}>
            <span className="cp-emoji" aria-hidden>{m.emoji}</span><span>{m.label}</span></button></li>
        ))}
        {!list.length && <li className="t-support" style={{ gridColumn: '1 / -1', padding: 16 }}>Nothing matches “{q}”.</li>}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------ tag people (friends only) */
export function TagPeople({ selected, onChange }: { selected: PublicProfile[]; onChange: (p: PublicProfile[]) => void }) {
  const { uid } = useAuth()
  const [q, setQ] = useState('')
  const friends = useAsync(async () => {
    const ids = await friendIds(uid!)
    if (!ids.length) return [] as PublicProfile[]
    const { data, error } = await supabase.from('profiles').select('id,username,display_name,avatar_path').in('id', ids.slice(0, 300))
    if (error) throw error
    return ((data ?? []) as PublicProfile[]).sort((a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username))
  }, [uid])
  const picked = new Set(selected.map(s => s.id))
  const shown = useMemo(() => (friends.data ?? []).filter(f => `${f.display_name} ${f.username}`.toLowerCase().includes(q.trim().toLowerCase())), [friends.data, q])
  const toggle = (f: PublicProfile) => {
    if (picked.has(f.id)) return onChange(selected.filter(s => s.id !== f.id))
    if (selected.length >= 10) return toast('You can tag up to 10 people.')
    onChange([...selected, f])
  }
  return (
    <div className="cp-sub">
      <SearchBox value={q} onChange={setQ} placeholder="Search friends" label="Search friends to tag" />
      <p className="t-meta" style={{ padding: '0 4px 8px' }}>You can tag friends. They’re notified and can remove the tag any time. {selected.length > 0 && <b>{selected.length} selected</b>}</p>
      {friends.loading ? <Spinner /> : !friends.data?.length ? <p className="t-support" style={{ padding: 16 }}>Add friends first, then you can tag them in posts.</p> : (
        <ul className="cp-list">{shown.map(f => (
          <li key={f.id}><label className="cp-row">
            <Avatar path={f.avatar_path} name={f.display_name || f.username} />
            <span className="grow"><span className="t-name">{f.display_name || f.username}</span><span className="t-meta" style={{ display: 'block' }}>@{f.username} · Friend</span></span>
            <input type="checkbox" className="cp-check" checked={picked.has(f.id)} onChange={() => toggle(f)} aria-label={`Tag ${f.display_name || f.username}`} />
          </label></li>))}
          {!shown.length && <li className="t-support" style={{ padding: 16 }}>No friends match “{q}”.</li>}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ location */
export interface PickedPlace { name: string; lat: number; lng: number }
export function PlacePicker({ value, onPick }: { value: PickedPlace | null; onPick: (p: PickedPlace | null) => void }) {
  const { profile } = useAuth()
  const [here] = usePlace(profile)
  const configured = useMapsConfigured()
  const [q, setQ] = useState('')
  const [remote, setRemote] = useState<Suggestion[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!configured || q.trim().length < 3) { setRemote([]); return }
    let live = true
    const t = setTimeout(() => { searchPlaces(q.trim(), { lat: here.lat, lng: here.lng }).then(r => live && setRemote(r), () => live && setRemote([])) }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [q, configured, here.lat, here.lng])
  const round = (n: number) => Math.round(n * 1000) / 1000      // ~100 m: enough for "at the venue", never a street-level track
  const cities = searchCities(q, 8)
  const choose = async (s: Suggestion) => {
    setBusy(true)
    try {
      const d = await placeDetails(s.place_id)
      if (d.lat == null || d.lng == null) return toast('That place has no map position.')
      onPick({ name: [d.name, d.city].filter(Boolean).join(', ').slice(0, 120) || s.text.slice(0, 120), lat: round(d.lat), lng: round(d.lng) })
    } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }
  const useMine = async () => {
    setBusy(true)
    try { const p = await locateMe(); onPick({ name: p.name.slice(0, 120), lat: round(p.lat), lng: round(p.lng) }) } catch (e) { toast(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div className="cp-sub">
      <SearchBox value={q} onChange={setQ} placeholder={configured ? 'Search places, venues, cities' : 'Search cities'} label="Search for a place" />
      <ul className="cp-list">
        <li><button className="cp-row" onClick={useMine} disabled={busy}><span className="cp-ico"><LocateFixed size={20} aria-hidden /></span><span className="grow"><span className="t-name">Use my current area</span><span className="t-meta" style={{ display: 'block' }}>Shares the nearest city, not your exact position</span></span></button></li>
        {value && <li><button className="cp-row" onClick={() => onPick(null)}><span className="cp-ico"><Check size={20} aria-hidden /></span><span className="grow"><span className="t-name">{value.name}</span><span className="t-meta" style={{ display: 'block' }}>Selected · tap to remove</span></span></button></li>}
        {remote.map(r => <li key={r.place_id}><button className="cp-row" disabled={busy} onClick={() => choose(r)}><span className="cp-ico"><MapPin size={20} aria-hidden /></span><span className="grow"><span className="t-name clamp-1">{r.main}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{r.secondary}</span></span></button></li>)}
        {cities.map(c => <li key={c.name + c.country}><button className="cp-row" onClick={() => onPick({ name: `${c.name}, ${c.country}`, lat: round(c.lat), lng: round(c.lng) })}><span className="cp-ico"><MapPin size={20} aria-hidden /></span><span className="grow"><span className="t-name">{c.name}</span><span className="t-meta" style={{ display: 'block' }}>{c.country}</span></span></button></li>)}
      </ul>
      {configured === false && <p className="t-meta" style={{ padding: 12 }}>Venue search turns on when maps are configured. Cities work now.</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ music */
export interface PickedSong { track_id?: string; title: string; artist: string; url?: string; preview_path?: string | null; artwork_path?: string | null }
let sharedAudio: HTMLAudioElement | null = null
export function useTrackPlayer() {
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => { sharedAudio?.pause(); setPlaying(null) }, [])
  const toggle = (t: { id: string; preview_path: string | null }) => {
    if (!t.preview_path) return
    if (!sharedAudio) sharedAudio = new Audio()
    if (playing === t.id) { sharedAudio.pause(); setPlaying(null); return }
    sharedAudio.src = brandUrl(t.preview_path); sharedAudio.onended = () => setPlaying(null)
    void sharedAudio.play().then(() => setPlaying(t.id), () => toast('Could not play this preview.'))
  }
  return [playing, toggle] as const
}
export function TrackArt({ path, size = 56 }: { path?: string | null; size?: number }) {
  return <span className="track-art" style={{ width: size, height: size, ...(path ? { backgroundImage: `url(${brandUrl(path)})` } : {}) }} aria-hidden>{!path && <Music2 size={size / 2.5} />}</span>
}
export function MusicPicker({ value, onPick }: { value: PickedSong | null; onPick: (s: PickedSong | null) => void }) {
  const { uid } = useAuth()
  const [tab, setTab] = useState<'foryou' | 'trending' | 'saved'>('foryou')
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [manual, setManual] = useState({ title: '', artist: '', url: '' })
  const [playing, toggle] = useTrackPlayer()
  useEffect(() => { const t = setTimeout(() => setDq(q), 300); return () => clearTimeout(t) }, [q])
  const list = useAsync(() => musicCatalog(tab, dq), [tab, dq])
  const save = async (t: Track) => { try { await setTrackSaved(t.id, uid!, !t.saved); list.reload() } catch (e) { toast(errMsg(e)) } }
  const addManual = () => {
    const title = manual.title.trim(), artist = manual.artist.trim(), url = manual.url.trim()
    if (!title || !artist) return toast('Add the song and the artist.')
    if (url && !/^https:\/\/\S+$/i.test(url)) return toast('The link must start with https://')
    onPick({ title: title.slice(0, 120), artist: artist.slice(0, 120), url: url || undefined })
  }
  return (
    <div className="cp-sub">
      <SearchBox value={q} onChange={setQ} placeholder="Search songs and artists" label="Search songs and artists" />
      <div className="cp-tabs" role="tablist" aria-label="Music lists">
        {([['foryou', 'For you'], ['trending', 'Trending'], ['saved', 'Saved']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`cp-tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <p className="error" role="alert" style={{ padding: 16 }}>{list.error}</p> : (
        <ul className="cp-list">
          {(list.data ?? []).map(t => (
            <li key={t.id} className="cp-row">
              <button className="cp-pick" onClick={() => onPick({ track_id: t.id, title: t.title, artist: t.artist, url: t.external_url ?? undefined, preview_path: t.preview_path, artwork_path: t.artwork_path })} aria-pressed={value?.track_id === t.id}>
                <TrackArt path={t.artwork_path} /><span className="grow" style={{ minWidth: 0 }}><span className="t-name clamp-1" style={{ display: 'block' }}>{t.title}</span><span className="t-meta clamp-1" style={{ display: 'block' }}>{t.artist}</span></span>
              </button>
              {t.preview_path && <button className="icon-btn round" aria-label={playing === t.id ? `Pause ${t.title}` : `Play a preview of ${t.title}`} onClick={() => toggle(t)}>{playing === t.id ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>}
              <button className="btn sm ghost" aria-pressed={t.saved} onClick={() => save(t)}>{t.saved ? 'Saved' : 'Save'}</button>
            </li>
          ))}
          {list.data && !list.data.length && <li className="t-support" style={{ padding: 16 }}>{list.data === null ? 'The music library needs the latest update.' : tab === 'saved' ? 'Songs you save appear here.' : dq ? `No songs match “${dq}”.` : 'The VYBE music library is empty for now. You can still add the song you’re listening to below.'}</li>}
        </ul>
      )}
      <div className="cp-manual">
        <h3 className="t-section">Add a song yourself</h3>
        <p className="t-meta" style={{ marginBottom: 8 }}>Name the song and artist; add a link to it if you like.</p>
        <input className="input" aria-label="Song title" placeholder="Song title" maxLength={120} value={manual.title} onChange={e => setManual({ ...manual, title: e.target.value })} />
        <input className="input" aria-label="Artist" placeholder="Artist" maxLength={120} value={manual.artist} onChange={e => setManual({ ...manual, artist: e.target.value })} />
        <input className="input" aria-label="Link (optional)" placeholder="https://… (optional)" inputMode="url" value={manual.url} onChange={e => setManual({ ...manual, url: e.target.value })} />
        <button className="btn primary" onClick={addManual}>Use this song</button>
      </div>
    </div>
  )
}
