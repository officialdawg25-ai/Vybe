import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CreditCard, ExternalLink, Landmark, MapPin, Navigation, Plus, Share2, Ticket as TicketIcon, Trash2, Users } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useAsync, useSubmit } from '../lib/hooks'
import { directionsUrl, distanceKm } from '../lib/cities'
import { usePlace } from '../lib/location'
import { formatDistance, formatDuration, routeBetween, staticMap, useMapsConfigured, type Mode, type RouteInfo } from '../lib/maps'
import { uploadMedia } from '../lib/media'
import { createOrder, isMissingSchema, loadTicketTypes, money, newIdempotencyKey, saleState, startPayment, submitCheckout, type Provider, type TicketType } from '../lib/tickets'
import { ErrorState, Field, Sheet, Spinner, errMsg, toast, useSigned } from '../ui'
import { formatEventTime } from '../lib/format'
import { playSound } from '../lib/sounds'
import type { EventRow } from '../lib/types'
import { referralFor } from '../lib/reputation'
import { priceOrder, type FeeTerms } from '../lib/pricing'

/* ------------------------------------------------------------------ where / route */
export function WhereCard({ e }: { e: EventRow }) {
  const { profile } = useAuth()
  const [place] = usePlace(profile)
  const hasPlace = e.lat != null && e.lng != null
  const g = directionsUrl(e, 'google'), a = directionsUrl(e, 'apple')
  if (!hasPlace && !e.venue && !e.address && !e.location) return null
  const km = hasPlace ? distanceKm(place, { lat: e.lat!, lng: e.lng! }) : null
  const lines = [e.venue, e.address, [e.city, e.country].filter(Boolean).join(', ')].filter(Boolean)
  const share = async () => { if (g && navigator.share) { try { await navigator.share({ title: `Directions to ${e.title}`, url: g }) } catch { /* dismissed */ } } else if (g) { await navigator.clipboard.writeText(g); toast('Directions link copied') } }
  return (
    <section className="card" aria-labelledby="where-h" style={{ marginBottom: 16 }}>
      <h2 id="where-h" className="t-section" style={{ marginBottom: 6 }}><MapPin size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Where</h2>
      {lines.map((l, i) => <p key={i} className={i === 0 ? 't-name' : 't-support'}>{l}</p>)}
      {e.location && <p className="t-meta">{e.location}</p>}
      {km != null && <p className="t-meta" style={{ marginTop: 4 }}>{km < 1 ? 'Under 1 km' : `About ${Math.round(km)} km`} from {place.name} (straight line)</p>}
      {hasPlace && e.format !== 'online' && <MapPreview e={e} origin={place} />}
      {g && (
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
          <a className="btn sm primary" href={g} target="_blank" rel="noopener noreferrer"><Navigation size={16} aria-hidden /> Directions</a>
          {a && <a className="btn sm" href={a} target="_blank" rel="noopener noreferrer">Apple Maps</a>}
          <button className="btn sm" onClick={share}><Share2 size={16} aria-hidden /> Share route</button>
        </div>
      )}
    </section>
  )
}

/** Static map + a real route estimate from the viewer's chosen place. Needs the maps function; otherwise renders nothing (the address and directions link above still work). */
function MapPreview({ e, origin }: { e: EventRow; origin: { name: string; lat: number; lng: number } }) {
  const configured = useMapsConfigured()
  const [src, setSrc] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('DRIVE')
  const [route, setRoute] = useState<RouteInfo | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!configured) return
    let live = true, url: string | null = null
    staticMap([{ lat: e.lat!, lng: e.lng! }], { w: 600, h: 260, dark: document.documentElement.dataset.theme === 'dark' }).then(u => { url = u; if (live) setSrc(u); else if (u) URL.revokeObjectURL(u) })
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [configured, e.lat, e.lng])
  if (!configured) return null
  const estimate = async (m: Mode) => {
    setMode(m); setBusy(true); setMsg(''); setRoute(null)
    try { setRoute(await routeBetween({ lat: origin.lat, lng: origin.lng }, { lat: e.lat!, lng: e.lng! }, m)) } catch (x) { setMsg(errMsg(x)) } finally { setBusy(false) }
  }
  return (
    <div style={{ marginTop: 10 }}>
      {src && <img className="map-img" style={{ marginBottom: 8 }} src={src} alt={`Map showing ${e.venue || e.title}`} />}
      <div className="route-row" role="group" aria-label="Travel time">
        {(['DRIVE', 'WALK', 'TRANSIT', 'BICYCLE'] as Mode[]).map(m => <button key={m} className="chip" aria-pressed={route?.mode === m || (busy && mode === m)} disabled={busy} onClick={() => estimate(m)}>{{ DRIVE: 'Drive', WALK: 'Walk', TRANSIT: 'Transit', BICYCLE: 'Cycle' }[m]}</button>)}
      </div>
      {busy && <p className="t-meta" role="status">Finding a route…</p>}
      {route && <p className="t-meta" role="status" style={{ marginTop: 6 }}>{formatDuration(route.duration_s)} · {formatDistance(route.distance_m)} from {origin.name}. Estimates change with traffic and start point.</p>}
      {msg && <p className="t-meta" role="status" style={{ marginTop: 6 }}>{msg}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ lineup */
interface Act { id: string; name: string; role: string; bio: string; image_path: string | null; sort: number; status?: 'pending' | 'confirmed' | 'changed' | 'disputed' | 'cancelled'; status_note?: string }
/** What VYBE has established about an act (migration 27). Never inferred from a tag or a poster. */
const ACT_STATUS: Record<NonNullable<Act['status']>, { label: string; hint: string }> = {
  confirmed: { label: 'Confirmed', hint: 'VYBE checked this act’s participation with a trusted source' },
  pending: { label: 'Not yet verified', hint: 'The organiser listed this act; VYBE has not confirmed it yet' },
  changed: { label: 'Changed', hint: 'This listing changed after it was confirmed and is being re-checked' },
  disputed: { label: 'Disputed', hint: 'Someone has questioned this listing; VYBE is looking into it' },
  cancelled: { label: 'Cancelled', hint: 'This act is no longer appearing' },
}
const ROLES = ['Headliner', 'Guest', 'DJ', 'Live act', 'Host / MC', 'Speaker', 'Special guest']

function ActPhoto({ path, name }: { path: string | null; name: string }) {
  const url = useSigned(path)
  return url ? <img className="act-photo" src={url} alt="" loading="lazy" decoding="async" /> : <span className="act-photo act-fallback" aria-hidden>{name.charAt(0).toUpperCase()}</span>
}

export function LineupSection({ eventId, manage }: { eventId: string; manage: boolean }) {
  const { uid } = useAuth()
  const [adding, setAdding] = useState(false)
  const acts = useAsync(async () => {
    let r = await supabase.from('event_lineup').select('id,name,role,bio,image_path,sort,status,status_note').eq('event_id', eventId).order('sort').order('created_at')
    if (r.error && isMissingSchema(r.error)) r = await supabase.from('event_lineup').select('id,name,role,bio,image_path,sort').eq('event_id', eventId).order('sort').order('created_at') as typeof r
    if (r.error) { if (isMissingSchema(r.error)) return [] as Act[]; throw r.error }
    return (r.data ?? []) as Act[]
  }, [eventId])
  const remove = async (a: Act) => {
    if (!confirm(`Remove ${a.name} from the lineup?`)) return
    const { error } = await supabase.from('event_lineup').delete().eq('id', a.id)
    if (error) return toast(errMsg(error))
    if (a.image_path && a.image_path.startsWith(`${uid}/`)) await supabase.storage.from('media').remove([a.image_path])
    acts.reload()
  }
  if (acts.loading) return null
  if (!acts.data?.length && !manage) return null
  return (
    <section aria-labelledby="lineup-h" style={{ marginBottom: 20 }}>
      <div className="row between"><h2 id="lineup-h" className="t-section">Lineup</h2>{manage && <button className="btn sm" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Add</button>}</div>
      {acts.error ? <ErrorState message={acts.error} onRetry={acts.reload} /> : !acts.data?.length ? <p className="t-support" style={{ padding: '8px 0' }}>Add the artists, hosts and special guests people can expect.</p> : (
        <ul className="lineup">{acts.data.map(a => (
          <li key={a.id} className="act">
            <ActPhoto path={a.image_path} name={a.name} />
            <div className="grow"><div className="t-name">{a.name}{a.status && <span className={`act-status s-${a.status}`} title={ACT_STATUS[a.status].hint}>{ACT_STATUS[a.status].label}</span>}</div><div className="t-meta">{a.role}</div>{a.bio && <p className="t-support clamp-2">{a.bio}</p>}{a.status_note && a.status !== 'confirmed' && <p className="t-meta">{a.status_note}</p>}</div>
            {manage && <button className="icon-btn" aria-label={`Remove ${a.name}`} onClick={() => remove(a)}><Trash2 size={18} /></button>}
          </li>))}</ul>
      )}
      {adding && <AddAct eventId={eventId} next={(acts.data?.length ?? 0) + 1} onClose={() => { setAdding(false); acts.reload() }} />}
    </section>
  )
}

function AddAct({ eventId, next, onClose }: { eventId: string; next: number; onClose: () => void }) {
  const { uid } = useAuth()
  const [name, setName] = useState(''), [role, setRole] = useState('Guest'), [bio, setBio] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const save = () => submit(async () => {
    if (!name.trim()) return setErr('Enter a name.')
    let image_path: string | null = null
    try {
      if (file) image_path = (await uploadMedia(uid!, file)).path
      const { error } = await supabase.from('event_lineup').insert({ event_id: eventId, name: name.trim(), role, bio: bio.trim(), image_path, sort: next })
      if (error) throw error
      onClose()
    } catch (e) { if (image_path) await supabase.storage.from('media').remove([image_path]); setErr(errMsg(e)) }
  })
  return (
    <Sheet title="Add to lineup" onClose={onClose}>
      <Field id="a-name" label="Name"><input id="a-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
      <Field id="a-role" label="Role"><select id="a-role" className="select" value={role} onChange={e => setRole(e.target.value)}>{ROLES.map(r => <option key={r}>{r}</option>)}</select></Field>
      <Field id="a-bio" label="About (optional)"><textarea id="a-bio" className="textarea" value={bio} maxLength={300} onChange={e => setBio(e.target.value)} /></Field>
      <Field id="a-img" label="Photo (optional)" hint="Use a photo you have the rights to share."><input id="a-img" type="file" className="input" accept="image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} /></Field>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Add</button></div>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ tickets */
export function TicketsSection({ e, manage }: { e: EventRow; manage: boolean }) {
  const types = useAsync(() => loadTicketTypes(e.id), [e.id])
  const [qty, setQty] = useState<Record<string, number>>({})
  const [checkout, setCheckout] = useState(false)
  const [creating, setCreating] = useState(false)
  const ended = new Date(e.ends_at ?? new Date(new Date(e.starts_at).getTime() + 6 * 3600_000)).getTime() < Date.now()
  const chosen = (types.data ?? []).filter(t => (qty[t.id] ?? 0) > 0)
  const subtotal = chosen.reduce((s, t) => s + t.price_cents * (qty[t.id] ?? 0), 0)
  const count = chosen.reduce((s, t) => s + (qty[t.id] ?? 0) * t.group_size, 0)
  // Paid sales wait for VYBE's review of the event (the server enforces it; this only explains it). Older servers: no field.
  const paidLocked = e.sales_review !== undefined && e.sales_review !== null && e.sales_review !== 'approved'

  if (types.loading) return <Spinner />
  if (types.error) return <ErrorState message={types.error} onRetry={types.reload} />
  if (!types.data?.length && !manage) return e.ticket_url ? null : null
  return (
    <section className="card" aria-labelledby="tix-h" style={{ marginBottom: 20 }}>
      <div className="row between"><h2 id="tix-h" className="t-section"><TicketIcon size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Tickets</h2>
        <Link to="/app/tickets" className="t-meta">My tickets</Link></div>
      {!types.data?.length ? <p className="t-support" style={{ padding: '8px 0' }}>No tickets yet. Add a ticket type to start selling.</p> : (
        <ul className="tix">{types.data.map(t => {
          const s = saleState(t), soldOut = t.left <= 0, locked = t.price_cents > 0 && paidLocked
          const can = !ended && e.status === 'active' && s === 'on_sale' && !soldOut && !manage && !locked
          const n = qty[t.id] ?? 0
          return (
            <li key={t.id} className="tix-row">
              <div className="grow">
                <div className="t-name">{t.name} {t.kind === 'group' && <span className="tag">Group of {t.group_size}</span>}</div>
                {t.description && <div className="t-support">{t.description}</div>}
                <div className="t-meta">{t.price_cents ? money(t.price_cents) : 'Free'}{t.kind === 'group' ? ' per group' : ''} · {locked ? (e.sales_review === 'suspended' ? 'Sales paused by VYBE' : 'On sale once VYBE has reviewed this event') : soldOut ? 'Sold out' : s === 'soon' ? 'Sales open soon' : s === 'closed' ? 'Sales closed' : s === 'paused' ? 'Paused' : t.left <= 10 ? `Only ${t.left} left` : `${t.left} left`}</div>
              </div>
              {can && (
                <div className="stepper" role="group" aria-label={`Quantity of ${t.name}`}>
                  <button className="icon-btn" aria-label={`Fewer ${t.name}`} disabled={n === 0} onClick={() => setQty(q => ({ ...q, [t.id]: n - 1 }))}>−</button>
                  <output aria-live="polite">{n}</output>
                  <button className="icon-btn" aria-label={`More ${t.name}`} disabled={n >= Math.min(t.max_per_order, t.left)} onClick={() => setQty(q => ({ ...q, [t.id]: n + 1 }))}>+</button>
                </div>
              )}
              {manage && <ManageType t={t} onChanged={types.reload} />}
            </li>)
        })}</ul>
      )}
      {!manage && chosen.length > 0 && (
        <div className="row between" style={{ marginTop: 12 }}>
          <span className="t-name">{count} {count === 1 ? 'ticket' : 'tickets'} · {subtotal ? money(subtotal) : 'Free'}</span>
          <button className="btn primary" onClick={() => setCheckout(true)}>{subtotal ? 'Checkout' : 'Get tickets'}</button>
        </div>
      )}
      {!manage && e.ticket_url && <p className="t-meta" style={{ marginTop: 8 }}>Also sold externally: <a href={e.ticket_url} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: 'var(--brand)', fontWeight: 600 }}>ticket link <ExternalLink size={12} aria-hidden /></a></p>}
      {manage && <div style={{ marginTop: 12 }}><button className="btn sm" onClick={() => setCreating(true)}><Plus size={16} aria-hidden /> Add ticket type</button><SalesSummary eventId={e.id} /></div>}
      {checkout && <CheckoutSheet e={e} items={chosen.map(t => ({ ticket_type_id: t.id, qty: qty[t.id] ?? 0, name: t.name, price: t.price_cents }))} subtotal={subtotal} units={count} onClose={() => setCheckout(false)} />}
      {creating && <NewTicketType eventId={e.id} next={(types.data?.length ?? 0) + 1} onClose={() => { setCreating(false); types.reload() }} />}
    </section>
  )
}

function CheckoutSheet({ e, items, subtotal, units, onClose }: { e: EventRow; items: { ticket_type_id: string; qty: number; name: string; price: number }[]; subtotal: number; units: number; onClose: () => void }) {
  // What the buyer pays on top, from the same terms the server prices with (migration 29). Older servers: unknown (null).
  const terms = useAsync(async () => {
    if (!subtotal) return null
    const { data, error } = await supabase.rpc('buyer_fee_terms', { p_event: e.id })
    return error || !data ? null : data as Pick<FeeTerms, 'buyer_fee_enabled' | 'buyer_fee_bps' | 'buyer_fee_fixed_cents' | 'buyer_fee_per_ticket_cents'>
  }, [e.id, subtotal])
  const fee = terms.data ? priceOrder({ commission_bps: 0, commission_fixed_cents: 0, commission_per_ticket_cents: 0, ...terms.data }, subtotal, units).buyer_fee_cents : null
  const nav = useNavigate()
  const [provider, setProvider] = useState<Provider>('payfast')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const key = useRef(newIdempotencyKey())
  const pay = async () => {
    if (busy) return
    setBusy(true); setErr('')
    let orderId = ''
    try {
      const o = await createOrder(e.id, items.map(i => ({ ticket_type_id: i.ticket_type_id, qty: i.qty })), provider, key.current, subtotal > 0 ? referralFor(e.id) : null)
      orderId = o.id
      if (o.status === 'paid') { playSound('success'); toast('Tickets confirmed'); nav('/app/tickets', { replace: true }); return }
      submitCheckout(await startPayment(o.id))          // leaves the page; the order page finishes the story on return
    } catch (x) {
      setErr(errMsg(x))
      if (orderId) await supabase.rpc('cancel_my_order', { p_order: orderId })      // never leave stock held if we could not start paying
      key.current = newIdempotencyKey(); setBusy(false)
    }
  }
  return (
    <Sheet title="Review and pay" onClose={onClose}>
      <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map(i => <li key={i.ticket_type_id} className="item row"><span className="grow">{i.qty} × {i.name}</span><span>{i.price ? money(i.price * i.qty) : 'Free'}</span></li>)}
        {fee ? <>
          <li className="item row"><span className="grow">Subtotal</span><span>{money(subtotal)}</span></li>
          <li className="item row"><span className="grow">Service fee</span><span>{money(fee)}</span></li>
          <li className="item row"><span className="grow t-name">Total</span><span className="t-name">{money(subtotal + fee)}</span></li>
        </> : <li className="item row"><span className="grow t-name">Total</span><span className="t-name">{subtotal ? money(subtotal) : 'Free'}</span></li>}
      </ul>
      {subtotal > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0' }}>
          <legend className="t-section" style={{ marginBottom: 8 }}>Pay with</legend>
          {([['payfast', 'PayFast', 'Card, instant EFT, Capitec Pay and more', CreditCard], ['ozow', 'Ozow', 'Instant EFT from your own bank app', Landmark]] as const).map(([id, label, hint, Icon]) => (
            <label key={id} className={`pay-opt${provider === id ? ' on' : ''}`}>
              <input type="radio" name="provider" checked={provider === id} onChange={() => setProvider(id)} />
              <Icon size={20} aria-hidden /><span className="grow"><span className="t-name">{label}</span><br /><span className="t-meta">{hint}</span></span>
            </label>))}
          <p className="t-meta">{terms.data === null && !terms.loading ? 'Any service fee is shown on the next screen before you pay. ' : fee === 0 ? 'No booking fee: you pay the ticket price. ' : ''}Your payment is processed by the provider you choose; VYBE never sees your card or bank details.</p>
        </fieldset>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={busy}>Back</button>
        <button className="btn primary" onClick={pay} disabled={busy}>{busy ? 'Please wait…' : subtotal ? 'Continue to payment' : 'Confirm'}</button>
      </div>
    </Sheet>
  )
}

function ManageType({ t, onChanged }: { t: TicketType & { left: number }; onChanged: () => void }) {
  const sold = t.quantity_total - t.left
  const toggle = async () => { const { error } = await supabase.from('ticket_types').update({ status: t.status === 'active' ? 'paused' : 'active' }).eq('id', t.id); if (error) toast(errMsg(error)); else onChanged() }
  const del = async () => { if (!confirm(`Delete ${t.name}?`)) return; const { error } = await supabase.from('ticket_types').delete().eq('id', t.id); if (error) toast('Ticket types that have sales cannot be deleted. Pause it instead.'); else onChanged() }
  return (
    <div className="stack" style={{ gap: 4, justifyItems: 'end' }}>
      <span className="t-meta">{sold}/{t.quantity_total} sold</span>
      <div className="row" style={{ gap: 4 }}><button className="btn sm" onClick={toggle}>{t.status === 'active' ? 'Pause' : 'Resume'}</button>{sold === 0 && <button className="icon-btn" aria-label={`Delete ${t.name}`} onClick={del}><Trash2 size={18} /></button>}</div>
    </div>
  )
}

function SalesSummary({ eventId }: { eventId: string }) {
  const s = useAsync(async () => {
    const { data, error } = await supabase.from('orders').select('subtotal_cents,fee_cents,total_cents,status').eq('event_id', eventId).eq('status', 'paid')
    if (error) throw error
    const rows = data ?? []
    return { orders: rows.length, subtotal: rows.reduce((a, r) => a + Number(r.subtotal_cents), 0), fees: rows.reduce((a, r) => a + Number(r.fee_cents), 0) }
  }, [eventId])
  if (!s.data) return null
  return <p className="t-meta" style={{ marginTop: 8 }}><Users size={12} aria-hidden /> {s.data.orders} paid orders · ticket sales {money(s.data.subtotal)} (service fees paid by buyers: {money(s.data.fees)}). Payouts: your organisation’s Finance tab, or Earnings for personal events.</p>
}

function NewTicketType({ eventId, next, onClose }: { eventId: string; next: number; onClose: () => void }) {
  const [name, setName] = useState(''), [desc, setDesc] = useState(''), [kind, setKind] = useState<'single' | 'group'>('single')
  const [size, setSize] = useState('4'), [price, setPrice] = useState(''), [qty, setQty] = useState('100'), [max, setMax] = useState('6')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const save = () => submit(async () => {
    const cents = Math.round(parseFloat(price || '0') * 100)
    if (!name.trim()) return setErr('Name the ticket (e.g. General, VIP, Table for 4).')
    if (!Number.isFinite(cents) || cents < 0) return setErr('Enter a valid price in rand.')
    if (cents > 0 && cents < 500) return setErr('Paid tickets must cost at least R5.00 (the gateways’ minimum).')
    const { error } = await supabase.from('ticket_types').insert({
      event_id: eventId, name: name.trim(), description: desc.trim(), kind, group_size: kind === 'group' ? Math.min(20, Math.max(2, parseInt(size, 10) || 2)) : 1,
      price_cents: cents, quantity_total: Math.max(1, parseInt(qty, 10) || 1), max_per_order: Math.min(20, Math.max(1, parseInt(max, 10) || 1)), sort: next,
    })
    if (error) return setErr(errMsg(error))
    onClose()
  })
  return (
    <Sheet title="New ticket type" onClose={onClose}>
      <Field id="t-name" label="Name"><input id="t-name" className="input" value={name} maxLength={60} onChange={e => setName(e.target.value)} /></Field>
      <Field id="t-desc" label="Description (optional)"><input id="t-desc" className="input" value={desc} maxLength={300} onChange={e => setDesc(e.target.value)} /></Field>
      <Field id="t-kind" label="Type"><select id="t-kind" className="select" value={kind} onChange={e => setKind(e.target.value as 'single' | 'group')}><option value="single">Individual ticket</option><option value="group">Group bundle (one purchase, several tickets)</option></select></Field>
      {kind === 'group' && <Field id="t-size" label="Tickets per bundle"><input id="t-size" inputMode="numeric" className="input" value={size} onChange={e => setSize(e.target.value.replace(/\D/g, ''))} /></Field>}
      <Field id="t-price" label={kind === 'group' ? 'Price per bundle (R)' : 'Price (R)'} hint="0 for free. Service fees are added for the buyer."><input id="t-price" inputMode="decimal" className="input" value={price} onChange={e => setPrice(e.target.value)} /></Field>
      <div className="row"><div className="grow"><Field id="t-qty" label={kind === 'group' ? 'Bundles for sale' : 'Quantity for sale'}><input id="t-qty" inputMode="numeric" className="input" value={qty} onChange={e => setQty(e.target.value.replace(/\D/g, ''))} /></Field></div>
        <div className="grow"><Field id="t-max" label="Max per order"><input id="t-max" inputMode="numeric" className="input" value={max} onChange={e => setMax(e.target.value.replace(/\D/g, ''))} /></Field></div></div>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Add</button></div>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ share to feed */
export function ShareToFeed({ e }: { e: EventRow }) {
  const { uid } = useAuth()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [vis, setVis] = useState<'public' | 'friends'>(e.visibility === 'public' ? 'public' : 'friends')
  const [busy, submit] = useSubmit()
  const allowed = e.visibility !== 'invite' || e.host === uid
  const post = () => submit(async () => {
    const { error } = await supabase.from('posts').insert({ author: uid, body: text.trim() || `I'm looking at “${e.title}”`, visibility: vis, event_id: e.id })
    if (error) return toast(errMsg(error))
    playSound('share'); toast('Shared to your feed'); setOpen(false)
  })
  if (!allowed) return null
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}><Share2 size={16} aria-hidden /> Share to feed</button>
      {open && (
        <Sheet title="Share this plan" onClose={() => setOpen(false)}>
          <Field id="sh-text" label="Say something (optional)"><textarea id="sh-text" className="textarea" value={text} maxLength={500} onChange={ev => setText(ev.target.value)} /></Field>
          <Field id="sh-vis" label="Who can see this post"><select id="sh-vis" className="select" value={vis} onChange={ev => setVis(ev.target.value as 'public' | 'friends')}>{e.visibility === 'public' && <option value="public">Public</option>}<option value="friends">Friends</option></select></Field>
          <p className="t-meta" style={{ marginBottom: 12 }}>People still need permission to see the plan itself.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={post}>Share</button></div>
        </Sheet>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ live */
export function LiveCard({ eventId }: { eventId: string }) {
  const live = useAsync(async () => {
    const { data } = await supabase.from('live_streams').select('id,title,status,scheduled_for,access').eq('event_id', eventId).in('status', ['scheduled', 'live']).order('scheduled_for').limit(3)
    return (data ?? []) as { id: string; title: string; status: string; scheduled_for: string | null; access?: string }[]
  }, [eventId])
  if (!live.data?.length) return null
  return (
    <section className="card" aria-labelledby="live-h" style={{ marginBottom: 16 }}>
      <h2 id="live-h" className="t-section">Live stream</h2>
      {live.data.map(s => (
        <div key={s.id} className="row" style={{ margin: '6px 0' }}>
          <span className="grow t-support">{s.status === 'live' ? '● Live now' : s.scheduled_for ? formatEventTime(s.scheduled_for, Intl.DateTimeFormat().resolvedOptions().timeZone) : 'Scheduled'} · {s.title}{s.access === 'ticket' ? ' · ticket holders' : ''}</span>
          <Link className={`btn sm${s.status === 'live' ? ' primary' : ''}`} to={`/app/live/${s.id}`}>{s.status === 'live' ? 'Watch' : 'Open'}</Link>
        </div>))}
    </section>
  )
}

