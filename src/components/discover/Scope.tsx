import { useState } from 'react'
import { ChevronDown, Globe2, LocateFixed, MapPin } from 'lucide-react'
import { LocationPicker } from '../LocationPicker'
import { locateMe, usePlace } from '../../lib/location'
import { Sheet, errMsg, toast } from '../../ui'
import type { Scope } from './ResultsView'

const RADII = [10, 25, 50, 100, 250]
const read = (k: string) => { try { return sessionStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { sessionStorage.setItem(k, v) } catch { /* private mode: not remembered */ } }

// Discover always opens on All locations: a place chosen earlier is not carried into a new visit (opening the app again, a new tab,
// coming back to the app later). Moving between Discover and its category screens inside one visit keeps the choice.
try { if (sessionStorage.getItem('vybe:discover-fresh') !== '1') { sessionStorage.removeItem('vybe:discover-scope'); sessionStorage.setItem('vybe:discover-fresh', '1') } } catch { /* private mode */ }

/** Where Discover looks: a chosen town (with a radius) or everywhere. Shared by Discover and its category screens, and
 *  remembered for the session so moving between them keeps the same place. */
export function useDiscoverScope(profile: Parameters<typeof usePlace>[0]) {
  const [place, setPlace] = usePlace(profile)
  const [kind, setKindState] = useState<'all' | 'place'>(() => (read('vybe:discover-scope') === 'place' ? 'place' : 'all'))
  const [radius, setRadiusState] = useState(() => { const r = Number(read('vybe:discover-radius')); return RADII.includes(r) ? r : 50 })
  const [locating, setLocating] = useState(false)
  const setKind = (k: 'all' | 'place') => { setKindState(k); write('vybe:discover-scope', k) }
  const setRadius = (r: number) => { setRadiusState(r); write('vybe:discover-radius', String(r)) }
  const scope: Scope = kind === 'all' ? { label: 'all locations' } : { lat: place.lat, lng: place.lng, radiusKm: radius, label: place.name.replace(/^Near /, '') }
  const nearMe = async () => {
    setLocating(true)
    try { setPlace(await locateMe()); setKind('place') } catch (e) { toast(errMsg(e)) } finally { setLocating(false) }
  }
  return { place, setPlace, kind, setKind, radius, setRadius, scope, nearMe, locating }
}
export type DiscoverScope = ReturnType<typeof useDiscoverScope>

/** The compact location pill and the sheet behind it (choose a town, near me, everywhere, radius). */
export function LocationControl({ s }: { s: DiscoverScope }) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const name = s.kind === 'place' ? s.place.name.replace(/^Near /, '') : 'All locations'
  return (
    <>
      <button type="button" className="dloc" aria-haspopup="dialog" aria-label={`Location: ${s.scope.label}${s.kind === 'place' ? `, within ${s.radius} km` : ''}. Change`} onClick={() => setOpen(true)}>
        <MapPin size={16} aria-hidden /><span className="clamp-1">{name}</span>
        {s.kind === 'place' && <span className="dloc-km">{s.radius} km</span>}<ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <Sheet title="Where to explore" onClose={() => setOpen(false)}>
          <div className="loc-sheet">
            <button className="loc-opt" aria-pressed={s.kind === 'place'} onClick={() => { setOpen(false); setPicking(true) }}><MapPin size={20} aria-hidden /><span className="grow"><b>{s.kind === 'place' ? name : 'Switch city…'}</b><span className="t-meta">Pick another town or city</span></span></button>
            <button className="loc-opt" disabled={s.locating} onClick={() => { void s.nearMe().then(() => setOpen(false)) }}><LocateFixed size={20} aria-hidden /><span className="grow"><b>{s.locating ? 'Locating…' : 'Live location'}</b><span className="t-meta">Use where you are right now</span></span></button>
            <button className="loc-opt" aria-pressed={s.kind === 'all'} onClick={() => { s.setKind('all'); setOpen(false) }}><Globe2 size={20} aria-hidden /><span className="grow"><b>All locations</b><span className="t-meta">Everything, anywhere</span></span></button>
            <div className="field"><span className="t-name">Within</span>
              <div className="chips" role="group" aria-label="Search radius">{RADII.map(r => <button key={r} type="button" className="chip" aria-pressed={s.kind === 'place' && s.radius === r} onClick={() => { s.setRadius(r); s.setKind('place') }}>{r} km</button>)}</div>
            </div>
          </div>
        </Sheet>
      )}
      {picking && <LocationPicker title="Explore a place" onPick={p => { s.setPlace(p); s.setKind('place') }} onClose={() => setPicking(false)} />}
    </>
  )
}
