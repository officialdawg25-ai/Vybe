import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Field, errMsg } from '../ui'
import { localTimeZone, utcToZonedLocal, zonedLocalToUtc } from '../lib/format'
import type { EventRow } from '../lib/types'
import { LocationPicker } from './LocationPicker'
import { usePlace, type Place } from '../lib/location'
import { MapPin, Search } from 'lucide-react'
import { useCategories } from '../lib/discover'
import { placeDetails, searchPlaces, useMapsConfigured, type Suggestion } from '../lib/maps'

const ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC']

export function PlanForm({ initial, communityId, organizationId, onSaved, onCancel }: { initial?: EventRow; communityId?: string; organizationId?: string; onSaved: (id: string) => void; onCancel: () => void }) {
  const { uid } = useAuth()
  const tzDefault = initial?.timezone ?? localTimeZone()
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [tz, setTz] = useState(tzDefault)
  const [starts, setStarts] = useState(initial ? utcToZonedLocal(initial.starts_at, tzDefault) : '')
  const [ends, setEnds] = useState(initial?.ends_at ? utcToZonedLocal(initial.ends_at, tzDefault) : '')
  const [location, setLocation] = useState(initial?.location ?? '')
  const [visibility, setVisibility] = useState<EventRow['visibility']>(initial?.visibility ?? 'public')
  const [capacity, setCapacity] = useState(initial?.capacity?.toString() ?? '')
  const [price, setPrice] = useState(initial?.price_cents ? (initial.price_cents / 100).toString() : '')
  const [currency, setCurrency] = useState(initial?.currency ?? 'USD')
  const [ticketUrl, setTicketUrl] = useState(initial?.ticket_url ?? '')
  const [org, setOrg] = useState(initial?.organization_id ?? organizationId ?? '')
  const [community, setCommunity] = useState(initial?.community_id ?? communityId ?? '')
  const [category, setCategory] = useState(initial?.category ?? '')
  const [format, setFormat] = useState<'in_person' | 'online' | 'hybrid'>(initial?.format ?? 'in_person')
  const [onlineUrl, setOnlineUrl] = useState(initial?.online_url ?? '')
  const cats = useCategories()
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const { profile } = useAuth()
  const [myPlace] = usePlace(profile)
  const [where, setWhere] = useState<Place | null>(initial?.lat != null && initial?.lng != null ? { name: initial.city ?? 'Pinned location', country: initial.country ?? '', lat: initial.lat, lng: initial.lng } : null)
  const [venue, setVenue] = useState(initial?.venue ?? '')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [picking, setPicking] = useState(false)
  const mine = useAsync(async () => {
    const { data } = await supabase.from('community_members').select('community_id, communities(name)').eq('user_id', uid!).eq('status', 'active')
    return (data ?? []) as unknown as { community_id: string; communities: { name: string } }[]
  }, [uid])

  const orgs = useAsync(async () => {
    const { data } = await supabase.from('organization_members').select('organization_id, organizations(name)').eq('user_id', uid!).eq('status', 'active').in('role', ['owner', 'admin', 'editor'])
    return (data ?? []) as unknown as { organization_id: string; organizations: { name: string } }[]
  }, [uid])

  const save = (asDraft = false) => submit(async () => {
    setErr('')
    if (title.trim().length < 2) return setErr('Give your plan a title.')
    if (!starts) return setErr('Choose a start time.')
    const startIso = zonedLocalToUtc(starts, tz)
    const endIso = ends ? zonedLocalToUtc(ends, tz) : null
    if (endIso && endIso <= startIso) return setErr('The end time must be after the start.')
    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) return setErr('Ticket link must start with http:// or https://')
    const cents = price ? Math.round(parseFloat(price) * 100) : null
    if (price && (!Number.isFinite(cents!) || cents! < 0)) return setErr('Enter a valid price.')
    const cap = capacity ? parseInt(capacity, 10) : null
    if (capacity && (!cap || cap < 1)) return setErr('Capacity must be at least 1.')
    if (!asDraft && format !== 'in_person' && !/^https:\/\/\S+$/i.test(onlineUrl.trim())) return setErr('Add the https:// link people will use to join online.')
    if (onlineUrl && !/^https:\/\/\S+$/i.test(onlineUrl.trim())) return setErr('The online link must start with https://')
    if (!asDraft && format !== 'online' && visibility === 'public' && !where) return setErr('Choose the city this happens in so people nearby can find it.')
    const row = {
      city: where ? where.name.replace(/^Near /, '') : null, country: where?.country || null, lat: where?.lat ?? null, lng: where?.lng ?? null,
      venue: venue.trim() || null, address: address.trim() || null,
      title: title.trim(), description: description.trim(), starts_at: startIso, ends_at: endIso, timezone: tz,
      location: location.trim() || null, visibility, capacity: cap, price_cents: cents, currency: cents ? currency.toUpperCase() : null,
      ticket_url: ticketUrl.trim() || null,
      category: category || null, format, online_url: format === 'in_person' ? null : onlineUrl.trim() || null,
    }
    if (initial) {
      const publishNow = initial.status === 'draft' && !asDraft
      const { error } = await supabase.from('events').update({ ...row, ...(publishNow ? { status: 'active' } : {}) }).eq('id', initial.id)
      if (error) return setErr(errMsg(error))
      onSaved(initial.id)
    } else {
      const { data, error } = await supabase.from('events').insert({ ...row, status: asDraft ? 'draft' : 'active', host: uid, community_id: community || null, organization_id: org || null }).select('id').single()
      if (error) return setErr(errMsg(error))
      onSaved(data.id)
    }
  })

  return (
    <div>
      <h1 className="t-title" style={{ marginBottom: 16 }}>{initial ? 'Edit plan' : 'Create a plan'}</h1>
      <Field id="p-title" label="Title"><input id="p-title" className="input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Field>
      <Field id="p-desc" label="Description"><textarea id="p-desc" className="textarea" value={description} maxLength={4000} onChange={e => setDescription(e.target.value)} /></Field>
      <Field id="p-cat" label="Category" hint="Helps people find it in Discover."><select id="p-cat" className="select" value={category} onChange={e => setCategory(e.target.value)}><option value="">Choose a category</option>{cats.map(c => <option key={c.slug} value={c.slug}>{c.label}</option>)}</select></Field>
      <Field id="p-fmt" label="Format"><select id="p-fmt" className="select" value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="in_person">In person</option><option value="online">Online only</option><option value="hybrid">In person and online</option></select></Field>
      {format !== 'in_person' && <Field id="p-online" label="Online link" hint="Only people who are going (and you) see this link."><input id="p-online" type="url" className="input" value={onlineUrl} onChange={e => setOnlineUrl(e.target.value)} placeholder="https://" /></Field>}
      <Field id="p-start" label="Starts"><input id="p-start" type="datetime-local" className="input" value={starts} onChange={e => setStarts(e.target.value)} /></Field>
      <Field id="p-end" label="Ends (optional)"><input id="p-end" type="datetime-local" className="input" value={ends} onChange={e => setEnds(e.target.value)} /></Field>
      <Field id="p-tz" label="Time zone" hint="Times are shown to everyone in this zone, daylight saving included.">
        <select id="p-tz" className="select" value={tz} onChange={e => setTz(e.target.value)}>{(ZONES.includes(tz) ? ZONES : [tz, ...ZONES]).map(z => <option key={z}>{z}</option>)}</select>
      </Field>
      {format !== 'online' && <VenueSearch near={myPlace} onPick={(v, w) => { setVenue(v.name ?? ''); setAddress(v.address ?? ''); setWhere(w) }} />}
      {format !== 'online' && <div className="field">
        <span style={{ fontWeight: 600, fontSize: '.875rem' }}>City</span>
        <button type="button" className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => setPicking(true)}><MapPin size={18} aria-hidden /> {where ? `${where.name}${where.country ? `, ${where.country}` : ''}` : `Choose a city (you're browsing ${myPlace.name})`}</button>
        <span className="hint">Used to show this plan to people nearby and to give directions.</span>
      </div>}
      {format !== 'online' && <>
        <Field id="p-venue" label="Venue name (optional)"><input id="p-venue" className="input" value={venue} maxLength={120} onChange={e => setVenue(e.target.value)} placeholder="e.g. The Roof" /></Field>
        <Field id="p-addr" label="Street address (optional)"><input id="p-addr" className="input" value={address} maxLength={240} onChange={e => setAddress(e.target.value)} /></Field>
        <Field id="p-loc" label="Meeting point notes (optional)"><input id="p-loc" className="input" value={location} maxLength={200} onChange={e => setLocation(e.target.value)} placeholder="Where exactly to meet" /></Field>
      </>}
      <Field id="p-vis" label="Who can see this">
        <select id="p-vis" className="select" value={visibility} onChange={e => setVisibility(e.target.value as EventRow['visibility'])}>
          <option value="public">Public — anyone on VYBE</option><option value="friends">Friends of the host</option><option value="invite">Invite only</option>
        </select>
      </Field>
      {!initial && (mine.data?.length ?? 0) > 0 && (
        <Field id="p-com" label="Community (optional)"><select id="p-com" className="select" value={community} onChange={e => setCommunity(e.target.value)}>
          <option value="">None</option>{mine.data!.map(m => <option key={m.community_id} value={m.community_id}>{m.communities.name}</option>)}</select></Field>
      )}
      {!initial && (orgs.data?.length ?? 0) > 0 && (
        <Field id="p-org" label="Host as" hint="Hosting as an organization lets its editors manage this plan."><select id="p-org" className="select" value={org} onChange={e => setOrg(e.target.value)}>
          <option value="">Me</option>{orgs.data!.map(m => <option key={m.organization_id} value={m.organization_id}>{m.organizations.name}</option>)}</select></Field>
      )}
      <Field id="p-cap" label="Capacity (optional)"><input id="p-cap" inputMode="numeric" className="input" value={capacity} onChange={e => setCapacity(e.target.value.replace(/\D/g, ''))} /></Field>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="grow"><Field id="p-price" label="Ticket price (optional)" hint="Shown as a guide. To sell tickets on VYBE, add ticket types after you create the plan."><input id="p-price" inputMode="decimal" className="input" value={price} onChange={e => setPrice(e.target.value)} /></Field></div>
        <div style={{ width: 96 }}><Field id="p-cur" label="Currency"><input id="p-cur" className="input" value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} /></Field></div>
      </div>
      <Field id="p-url" label="External ticket link (optional)"><input id="p-url" type="url" className="input" value={ticketUrl} onChange={e => setTicketUrl(e.target.value)} placeholder="https://" /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      {picking && <LocationPicker title="Where is it happening?" onPick={p => setWhere(p)} onClose={() => setPicking(false)} />}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy} onClick={() => save(false)}>{initial ? (initial.status === 'draft' ? 'Publish' : 'Save changes') : 'Publish plan'}</button>
        {(!initial || initial.status === 'draft') && <button className="btn" disabled={busy} onClick={() => save(true)}>Save as draft</button>}
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** Venue/address lookup through the maps edge function. Without maps configured this renders nothing and the manual fields below still work. */
function VenueSearch({ near, onPick }: { near: Place; onPick: (v: { name: string | null; address: string | null }, w: Place) => void }) {
  const configured = useMapsConfigured()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Suggestion[]>([])
  const [msg, setMsg] = useState('')
  useEffect(() => {
    if (!configured || q.trim().length < 3) { setResults([]); return }
    let live = true
    const t = setTimeout(() => { searchPlaces(q.trim(), { lat: near.lat, lng: near.lng }).then(r => { if (live) { setResults(r); setMsg('') } }, e => live && setMsg((e as Error).message)) }, 350)
    return () => { live = false; clearTimeout(t) }
  }, [q, configured, near.lat, near.lng])
  if (!configured) return null
  const choose = async (s: Suggestion) => {
    setMsg('')
    try {
      const d = await placeDetails(s.place_id)
      if (d.lat == null || d.lng == null) return setMsg('That place has no map position. Pick another or enter the details yourself.')
      onPick({ name: d.name, address: d.address }, { name: d.city || d.name || 'Pinned location', country: d.country ?? '', lat: +d.lat.toFixed(5), lng: +d.lng.toFixed(5) })
      setQ(''); setResults([])
    } catch (e) { setMsg((e as Error).message) }
  }
  return (
    <div className="field">
      <label htmlFor="p-vsearch" style={{ fontWeight: 600, fontSize: '.875rem' }}>Find the venue</label>
      <div className="row discover-search"><Search size={18} aria-hidden /><input id="p-vsearch" className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search venues and addresses" autoComplete="off" /></div>
      {results.length > 0 && <ul className="list" role="listbox" aria-label="Venue suggestions" style={{ listStyle: 'none', padding: 0 }}>{results.map(r => <li key={r.place_id}><button type="button" role="option" aria-selected={false} className="item row link" style={{ width: '100%', textAlign: 'left' }} onClick={() => choose(r)}><MapPin size={16} aria-hidden /><span><b>{r.main}</b> <span className="t-meta">{r.secondary}</span></span></button></li>)}</ul>}
      {msg && <span className="hint" role="status">{msg}</span>}
      <span className="hint">Fills in the venue, address and map position. You can still edit them.</span>
    </div>
  )
}
