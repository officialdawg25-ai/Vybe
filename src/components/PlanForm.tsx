import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { Field, errMsg } from '../ui'
import { localTimeZone, utcToZonedLocal, zonedLocalToUtc } from '../lib/format'
import type { EventRow } from '../lib/types'

const ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC']

export function PlanForm({ initial, communityId, onSaved, onCancel }: { initial?: EventRow; communityId?: string; onSaved: (id: string) => void; onCancel: () => void }) {
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
  const [org, setOrg] = useState(initial?.organization_id ?? '')
  const [community, setCommunity] = useState(initial?.community_id ?? communityId ?? '')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const mine = useAsync(async () => {
    const { data } = await supabase.from('community_members').select('community_id, communities(name)').eq('user_id', uid!).eq('status', 'active')
    return (data ?? []) as unknown as { community_id: string; communities: { name: string } }[]
  }, [uid])

  const orgs = useAsync(async () => {
    const { data } = await supabase.from('organization_members').select('organization_id, organizations(name)').eq('user_id', uid!).eq('status', 'active').in('role', ['owner', 'admin', 'editor'])
    return (data ?? []) as unknown as { organization_id: string; organizations: { name: string } }[]
  }, [uid])

  const save = () => submit(async () => {
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
    const row = {
      title: title.trim(), description: description.trim(), starts_at: startIso, ends_at: endIso, timezone: tz,
      location: location.trim() || null, visibility, capacity: cap, price_cents: cents, currency: cents ? currency.toUpperCase() : null,
      ticket_url: ticketUrl.trim() || null,
    }
    if (initial) {
      const { error } = await supabase.from('events').update(row).eq('id', initial.id)
      if (error) return setErr(errMsg(error))
      onSaved(initial.id)
    } else {
      const { data, error } = await supabase.from('events').insert({ ...row, host: uid, community_id: community || null, organization_id: org || null }).select('id').single()
      if (error) return setErr(errMsg(error))
      onSaved(data.id)
    }
  })

  return (
    <div>
      <h1 className="t-title" style={{ marginBottom: 16 }}>{initial ? 'Edit plan' : 'Create a plan'}</h1>
      <Field id="p-title" label="Title"><input id="p-title" className="input" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Field>
      <Field id="p-desc" label="Description"><textarea id="p-desc" className="textarea" value={description} maxLength={4000} onChange={e => setDescription(e.target.value)} /></Field>
      <Field id="p-start" label="Starts"><input id="p-start" type="datetime-local" className="input" value={starts} onChange={e => setStarts(e.target.value)} /></Field>
      <Field id="p-end" label="Ends (optional)"><input id="p-end" type="datetime-local" className="input" value={ends} onChange={e => setEnds(e.target.value)} /></Field>
      <Field id="p-tz" label="Time zone" hint="Times are shown to everyone in this zone, daylight saving included.">
        <select id="p-tz" className="select" value={tz} onChange={e => setTz(e.target.value)}>{(ZONES.includes(tz) ? ZONES : [tz, ...ZONES]).map(z => <option key={z}>{z}</option>)}</select>
      </Field>
      <Field id="p-loc" label="Where"><input id="p-loc" className="input" value={location} maxLength={200} onChange={e => setLocation(e.target.value)} placeholder="Venue or meeting point" /></Field>
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
        <div className="grow"><Field id="p-price" label="Ticket price (optional)" hint="Informational only — VYBE does not process payments."><input id="p-price" inputMode="decimal" className="input" value={price} onChange={e => setPrice(e.target.value)} /></Field></div>
        <div style={{ width: 96 }}><Field id="p-cur" label="Currency"><input id="p-cur" className="input" value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} /></Field></div>
      </div>
      <Field id="p-url" label="External ticket link (optional)"><input id="p-url" type="url" className="input" value={ticketUrl} onChange={e => setTicketUrl(e.target.value)} placeholder="https://" /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy} onClick={save}>{initial ? 'Save changes' : 'Create plan'}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
