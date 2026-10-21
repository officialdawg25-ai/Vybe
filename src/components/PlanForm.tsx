import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Field, errMsg } from '../ui'
import { localTimeZone, utcToZonedLocal, zonedLocalToUtc } from '../lib/format'
import type { EventRow } from '../lib/types'
import { LocationPicker } from './LocationPicker'
import { usePlace, type Place } from '../lib/location'
import { Globe2, Lock, MapPin, Monitor, Search, Users, Wifi } from 'lucide-react'
import { Collapse } from './Collapse'
import { Choice, Wizard } from './Wizard'
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

  const validate = (asDraft: boolean): { error: string; at?: string } | null => {
    if (title.trim().length < 2) return { error: 'Give your plan a title.', at: 'idea' }
    if (!starts) return { error: 'Choose a start time.', at: 'when' }
    if (ends && zonedLocalToUtc(ends, tz) <= zonedLocalToUtc(starts, tz)) return { error: 'The end time must be after the start.', at: 'when' }
    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) return { error: 'Ticket link must start with http:// or https://', at: 'tickets' }
    if (price && (!Number.isFinite(Math.round(parseFloat(price) * 100)) || parseFloat(price) < 0)) return { error: 'Enter a valid price.', at: 'tickets' }
    if (capacity && !(parseInt(capacity, 10) >= 1)) return { error: 'Capacity must be at least 1.', at: 'tickets' }
    if (!asDraft && format !== 'in_person' && !/^https:\/\/\S+$/i.test(onlineUrl.trim())) return { error: 'Add the https:// link people will use to join online.', at: 'online' }
    if (onlineUrl && !/^https:\/\/\S+$/i.test(onlineUrl.trim())) return { error: 'The online link must start with https://', at: 'online' }
    if (!asDraft && format !== 'online' && visibility === 'public' && !where) return { error: 'Choose the city this happens in so people nearby can find it.', at: 'where' }
    return null
  }
  const save = (asDraft = false) => submit(async () => {
    setErr('')
    const bad = validate(asDraft); if (bad) return setErr(bad.error)
    const startIso = zonedLocalToUtc(starts, tz)
    const endIso = ends ? zonedLocalToUtc(ends, tz) : null
    const cents = price ? Math.round(parseFloat(price) * 100) : null
    const cap = capacity ? parseInt(capacity, 10) : null
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

  const whenText = starts ? `${starts.replace('T', ' at ')}${ends ? ` → ${ends.replace('T', ' at ')}` : ''} (${tz})` : 'Not set'
  const whereText = format === 'online' ? 'Online' : [venue, address, where ? `${where.name}${where.country ? `, ${where.country}` : ''}` : ''].filter(Boolean).join(' · ') || 'Not set'
  const VIS = { public: 'Public — anyone on VYBE', friends: 'Friends of the host', invite: 'Invite only' } as const
  const FMT = { in_person: 'In person', online: 'Online only', hybrid: 'In person and online' } as const
  const hasHosting = !initial && ((mine.data?.length ?? 0) > 0 || (orgs.data?.length ?? 0) > 0)
  const price$ = price ? `${currency.toUpperCase()} ${price}` : 'Free / not set'
  const dirty = Boolean(title || description || starts || venue || address || where)
  const rows: [string, string, string][] = [
    ['Plan', title || 'No title yet', 'idea'], ['Format', FMT[format], 'format'], ['When', whenText, 'when'], ['Who can see it', VIS[visibility], 'access'],
    ...(format !== 'online' ? [['Where', whereText, 'where'] as [string, string, string]] : []),
    ...(format !== 'in_person' ? [['Online link', onlineUrl || 'Not set', 'online'] as [string, string, string]] : []),
    ['Capacity & price', `${capacity ? `${capacity} places` : 'No limit'} · ${price$}`, 'tickets'],
  ]

  return (
    <>
      <Wizard title={initial ? 'Edit plan' : 'Create a plan'} onClose={onCancel} dirty={!initial && dirty} error={err}
        actions={[
          { label: initial ? (initial.status === 'draft' ? 'Publish' : 'Save changes') : 'Publish plan', primary: true, busy, onClick: () => save(false) },
          ...((!initial || initial.status === 'draft') ? [{ label: 'Save as draft', busy, onClick: () => save(true) }] : []),
        ]}
        steps={[
          { id: 'idea', phase: 'The idea', title: 'What are you planning?', hint: 'A short, clear name people will recognise.', check: () => (title.trim().length < 2 ? 'Give your plan a title.' : null), body: <>
            <Field id="p-title" label="Title"><input id="p-title" className="input" value={title} maxLength={120} autoFocus onChange={e => setTitle(e.target.value)} placeholder="e.g. Sunset beach braai" /></Field>
            <Collapse title="Category" summary={cats.find(c => c.slug === category)?.label ?? 'Optional'}>
              <div className="chips" role="radiogroup" aria-label="Category">{cats.map(c => <button key={c.slug} type="button" role="radio" aria-checked={category === c.slug} className="chip" aria-pressed={category === c.slug} onClick={() => setCategory(category === c.slug ? '' : c.slug)}>{c.label}</button>)}</div>
              <p className="hint">Helps people find it in Discover.</p>
            </Collapse>
          </> },
          { id: 'about', phase: 'The idea', title: 'Tell people more', hint: 'What should they expect? What should they bring?', optional: !description, body:
            <Field id="p-desc" label="Description"><textarea id="p-desc" className="textarea" rows={6} value={description} maxLength={4000} onChange={e => setDescription(e.target.value)} /></Field> },
          { id: 'format', phase: 'When & where', title: 'How will people join?', body:
            <Choice label="Format" value={format} onChange={setFormat} options={[
              { value: 'in_person', title: 'In person', text: 'Everyone meets at a place', icon: <MapPin size={22} /> },
              { value: 'online', title: 'Online only', text: 'Joined with a link', icon: <Monitor size={22} /> },
              { value: 'hybrid', title: 'In person and online', text: 'Both, with a link for people far away', icon: <Wifi size={22} /> }]} /> },
          { id: 'when', phase: 'When & where', title: 'When does it start?', hint: 'Times are shown to everyone in the time zone you pick, daylight saving included.', check: () => (!starts ? 'Choose a start time.' : ends && zonedLocalToUtc(ends, tz) <= zonedLocalToUtc(starts, tz) ? 'The end time must be after the start.' : null), body: <>
            <Field id="p-start" label="Starts"><input id="p-start" type="datetime-local" className="input" value={starts} onChange={e => setStarts(e.target.value)} /></Field>
            <Field id="p-end" label="Ends (optional)"><input id="p-end" type="datetime-local" className="input" value={ends} onChange={e => setEnds(e.target.value)} /></Field>
            <Collapse title="Time zone" summary={tz}>
              <select id="p-tz" className="select" aria-label="Time zone" value={tz} onChange={e => setTz(e.target.value)}>{(ZONES.includes(tz) ? ZONES : [tz, ...ZONES]).map(z => <option key={z}>{z}</option>)}</select>
            </Collapse>
          </> },
          { id: 'where', phase: 'When & where', title: 'Where is it?', hint: 'Used to show this plan to people nearby and to give directions.', hidden: format === 'online', body: <>
            <VenueSearch near={myPlace} onPick={(v, w) => { setVenue(v.name ?? ''); setAddress(v.address ?? ''); setWhere(w) }} />
            <div className="field">
              <span style={{ fontWeight: 600, fontSize: '.875rem' }}>City</span>
              <button type="button" className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => setPicking(true)}><MapPin size={18} aria-hidden /> {where ? `${where.name}${where.country ? `, ${where.country}` : ''}` : `Choose a city (you're browsing ${myPlace.name})`}</button>
            </div>
            <Collapse title="Venue and address details" summary={venue || address || 'Optional'}>
              <Field id="p-venue" label="Venue name"><input id="p-venue" className="input" value={venue} maxLength={120} onChange={e => setVenue(e.target.value)} placeholder="e.g. The Roof" /></Field>
              <Field id="p-addr" label="Street address"><input id="p-addr" className="input" value={address} maxLength={240} onChange={e => setAddress(e.target.value)} /></Field>
              <Field id="p-loc" label="Meeting point notes"><input id="p-loc" className="input" value={location} maxLength={200} onChange={e => setLocation(e.target.value)} placeholder="Where exactly to meet" /></Field>
            </Collapse>
          </> },
          { id: 'online', phase: 'When & where', title: 'How do they join online?', hint: 'Only people who are going (and you) see this link.', hidden: format === 'in_person', check: () => (onlineUrl && !/^https:\/\/\S+$/i.test(onlineUrl.trim()) ? 'The online link must start with https://' : null), body:
            <Field id="p-online" label="Online link"><input id="p-online" type="url" className="input" value={onlineUrl} onChange={e => setOnlineUrl(e.target.value)} placeholder="https://" /></Field> },
          { id: 'access', phase: 'Who can come', title: 'Who can see this?', body: <>
            <Choice label="Who can see this" value={visibility} onChange={setVisibility} options={[
              { value: 'public', title: 'Public', text: 'Anyone on VYBE can find it', icon: <Globe2 size={22} /> },
              { value: 'friends', title: 'Friends of the host', text: 'Only your friends', icon: <Users size={22} /> },
              { value: 'invite', title: 'Invite only', text: 'Only people you invite', icon: <Lock size={22} /> }]} />
            {hasHosting && <Collapse title="Hosting options" summary={org ? 'As an organisation' : community ? 'In a community' : 'Me'}>
              {(mine.data?.length ?? 0) > 0 && <Field id="p-com" label="Community (optional)"><select id="p-com" className="select" value={community} onChange={e => setCommunity(e.target.value)}>
                <option value="">None</option>{mine.data!.map(m => <option key={m.community_id} value={m.community_id}>{m.communities.name}</option>)}</select></Field>}
              {(orgs.data?.length ?? 0) > 0 && <Field id="p-org" label="Host as" hint="Hosting as an organization lets its editors manage this plan."><select id="p-org" className="select" value={org} onChange={e => setOrg(e.target.value)}>
                <option value="">Me</option>{orgs.data!.map(m => <option key={m.organization_id} value={m.organization_id}>{m.organizations.name}</option>)}</select></Field>}
            </Collapse>}
          </> },
          { id: 'tickets', phase: 'Who can come', title: 'Places and price', hint: 'Both are optional. To sell tickets on VYBE, add ticket types after you create the plan.', optional: !capacity && !price && !ticketUrl,
            check: () => (capacity && !(parseInt(capacity, 10) >= 1) ? 'Capacity must be at least 1.' : price && !(parseFloat(price) >= 0) ? 'Enter a valid price.' : ticketUrl && !/^https?:\/\//i.test(ticketUrl) ? 'Ticket link must start with http:// or https://' : null), body: <>
            <Field id="p-cap" label="Capacity"><input id="p-cap" inputMode="numeric" className="input" value={capacity} onChange={e => setCapacity(e.target.value.replace(/\D/g, ''))} placeholder="No limit" /></Field>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="grow"><Field id="p-price" label="Ticket price (a guide)"><input id="p-price" inputMode="decimal" className="input" value={price} onChange={e => setPrice(e.target.value)} placeholder="Free" /></Field></div>
              <div style={{ width: 96 }}><Field id="p-cur" label="Currency"><input id="p-cur" className="input" value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} /></Field></div>
            </div>
            <Collapse title="External ticket link" summary={ticketUrl || 'Optional'}>
              <Field id="p-url" label="Link"><input id="p-url" type="url" className="input" value={ticketUrl} onChange={e => setTicketUrl(e.target.value)} placeholder="https://" /></Field>
            </Collapse>
          </> },
          { id: 'review', phase: 'Review', title: initial ? 'Review your changes' : 'Ready to publish?', hint: 'Check the details. Tap Change to fix anything.', body: ({ go }) => (
            <dl className="wz-review">{rows.map(([k, v, at]) => <div key={k}><span><dt>{k}</dt><dd>{v}</dd></span><button type="button" onClick={() => go(at)}>Change</button></div>)}</dl>
          ) },
        ]} />
      {picking && <LocationPicker title="Where is it happening?" onPick={p => setWhere(p)} onClose={() => setPicking(false)} />}
    </>
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
