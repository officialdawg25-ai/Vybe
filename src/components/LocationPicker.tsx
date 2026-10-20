import { useState } from 'react'
import { LocateFixed, MapPin, Search } from 'lucide-react'
import { searchCities, type City } from '../lib/cities'
import { locateMe, type Place } from '../lib/location'
import { Sheet } from '../ui'

/** Choose a city from the built-in list, or share the device location (asked for only when you tap the button). */
export function LocationPicker({ onPick, onClose, title = 'Choose a location' }: { onPick: (p: Place) => void; onClose: () => void; title?: string }) {
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const results: City[] = searchCities(q, 12)
  const here = async () => {
    setBusy(true); setErr('')
    try { onPick(await locateMe()); onClose() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Sheet title={title} onClose={onClose}>
      <label className="row discover-search" style={{ marginBottom: 12 }}>
        <Search size={18} aria-hidden />
        <input className="input" type="search" autoFocus placeholder="Search a city or country" aria-label="Search a city or country" value={q} onChange={e => setQ(e.target.value)} />
      </label>
      <button className="btn" style={{ width: '100%', marginBottom: 8 }} onClick={here} disabled={busy}><LocateFixed size={18} aria-hidden /> {busy ? 'Locating…' : 'Use my current location'}</button>
      {err && <p className="error" role="alert">{err}</p>}
      <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '45vh', overflow: 'auto' }}>
        {results.map(c => (
          <li key={`${c.name}-${c.country}`}>
            <button className="item row link" style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => { onPick(c); onClose() }}>
              <MapPin size={18} aria-hidden /><span className="grow"><span className="t-name">{c.name}</span> <span className="t-meta">{c.country}</span></span>
            </button>
          </li>
        ))}
        {!results.length && <li className="t-support" style={{ padding: 12 }}>No match. Try a nearby larger city.</li>}
      </ul>
    </Sheet>
  )
}
