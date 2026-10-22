import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { putObject } from '../lib/media'
import { useAsync } from '../lib/hooks'
import { isMissingSchema } from '../lib/tickets'
import { HERO_EXT, HERO_LIMITS } from '../lib/hero'
import { promoUrl, safeLink, sniffCreative, type Placement, type PromoSlide } from '../lib/promos'
import { Empty, ErrorState, Field, Spinner, errMsg, toast } from '../ui'
import { SponsoredSlide } from './HomeBillboard'

type Status = 'draft' | 'submitted' | 'rejected' | 'live' | 'paused'
interface Campaign {
  id: string; title: string; subtitle: string; cta_label: string; cta_url: string; media_type: 'image' | 'video' | null; media_path: string | null
  accent: string; city: string | null; starts_at: string; ends_at: string | null; status: Status; placements: Placement[]; review_note: string | null
  submitted_at: string | null; advertiser: string
}
type Draft = Omit<Campaign, 'id' | 'status' | 'review_note' | 'submitted_at' | 'advertiser'> & { id?: string; status?: Status; review_note?: string | null }
const COLS = 'id,title,subtitle,cta_label,cta_url,media_type,media_path,accent,city,starts_at,ends_at,status,placements,review_note,submitted_at,advertiser'
const PLACES: { id: Placement; label: string; hint: string }[] = [
  { id: 'home', label: 'Home billboard', hint: 'Between the header and the feed, mixed with trending plans' },
  { id: 'discover', label: 'Discover hero', hint: 'At the top of Discover' },
]
const STATUS: Record<Status, string> = { draft: 'Draft', submitted: 'Waiting for VYBE review', rejected: 'Changes needed', live: 'Approved', paused: 'Paused by VYBE' }
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null)
const blank = (): Draft => ({ title: '', subtitle: '', cta_label: 'Learn more', cta_url: '', media_type: null, media_path: null, accent: '#6a4cff', city: null, starts_at: new Date().toISOString(), ends_at: null, placements: ['home'] })

/**
 * Organisation → Campaigns. Owners and admins draft a promotion, preview it, and submit it to VYBE for review. Only VYBE can
 * approve, publish, pause or reject (enforced by the database); the organisation sees the decision, the reason, and
 * delivery counts for its own campaigns. Paid billing for campaigns is not set up yet, so nothing here charges money.
 */
export function OrgCampaigns({ orgId, orgName }: { orgId: string; orgName: string }) {
  const list = useAsync(async () => {
    const r = await supabase.from('promo_slides').select(COLS).eq('organization_id', orgId).order('created_at', { ascending: false })
    if (r.error) { if (isMissingSchema(r.error)) return null; throw r.error }
    const rows = (r.data ?? []) as Campaign[]
    const stats = rows.length ? await supabase.from('promo_stats').select('slide_id,impressions,clicks').in('slide_id', rows.map(x => x.id)) : { data: [] }
    const totals = new Map<string, { i: number; c: number }>()
    for (const s of stats.data ?? []) { const t = totals.get(s.slide_id) ?? { i: 0, c: 0 }; t.i += s.impressions; t.c += s.clicks; totals.set(s.slide_id, t) }
    return { rows, totals }
  }, [orgId])
  const [edit, setEdit] = useState<Draft | null>(null)
  if (list.loading && !list.data) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (!list.data) return <p className="notice" role="status">Campaigns are being set up on this server. Check back after the next update.</p>
  if (edit) return <CampaignEditor key={edit.id ?? 'new'} orgId={orgId} orgName={orgName} initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload() }} />
  const { rows, totals } = list.data
  const now = Date.now()
  const live = (c: Campaign) => c.status === 'live' ? (new Date(c.starts_at).getTime() > now ? 'Approved · scheduled' : c.ends_at && new Date(c.ends_at).getTime() <= now ? 'Approved · ended' : 'Live now') : STATUS[c.status]
  return (
    <section aria-labelledby="oc-h" className="stack">
      <div className="row between"><h2 id="oc-h" className="t-section">Campaigns</h2><button className="btn primary sm" onClick={() => setEdit(blank())}>New campaign</button></div>
      <p className="t-meta">Promote your events or page on VYBE’s Home billboard or the Discover hero. Every campaign is reviewed by VYBE before it goes live and is always labelled “Sponsored · {orgName}”. Counts are real deliveries: one view and one click per member per day.</p>
      {!rows.length ? <Empty title="No campaigns yet">Create one, preview it, then send it to VYBE for review.</Empty> : (
        <div className="list">
          {rows.map(c => {
            const t = totals.get(c.id)
            const editable = c.status === 'draft' || c.status === 'submitted' || c.status === 'rejected'
            return (
              <div key={c.id} className="item stack" style={{ gap: 6 }}>
                <div className="row" style={{ alignItems: 'center', gap: 12 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t-name clamp-1">{c.title}</div>
                    <div className="t-meta"><span className={`oc-status ${c.status}`}>{live(c)}</span> · {c.placements.map(p => PLACES.find(x => x.id === p)?.label).join(' + ')} · {t?.i ?? 0} views · {t?.c ?? 0} clicks</div>
                  </div>
                  {editable && <button className="btn sm" onClick={() => setEdit(c)}>{c.status === 'rejected' ? 'Fix and resubmit' : 'Edit'}</button>}
                </div>
                {c.status === 'rejected' && c.review_note && <p className="notice" role="note" style={{ margin: 0 }}><b>VYBE’s note:</b> {c.review_note}</p>}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function CampaignEditor({ orgId, orgName, initial, onClose, onSaved }: { orgId: string; orgName: string; initial: Draft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))

  const upload = async (file?: File) => {
    if (!file) return
    const kind = await sniffCreative(file)
    if (!kind) return setErr('Use a real JPG, PNG or WebP image, or an MP4 or WebM video.')
    if (file.size > (kind === 'image' ? HERO_LIMITS.imageBytes : HERO_LIMITS.videoBytes)) return setErr(kind === 'image' ? 'Images can be up to 10 MB.' : 'Videos can be up to 50 MB.')
    setBusy(true); setErr(null)
    const path = `promo/o-${orgId}/${crypto.randomUUID()}.${HERO_EXT[file.type]}`
    setPct(0)
    try { await putObject('brand', path, file, file.type, { onProgress: (a, b) => setPct(Math.round((a / b) * 100)) }) }
    catch (e) { setBusy(false); setPct(null); return setErr(`Upload failed: ${(e as Error).message}`) }
    setBusy(false); setPct(null)
    set({ media_type: kind, media_path: path })
  }

  const save = async (status: 'draft' | 'submitted') => {
    if (d.title.trim().length < 2) return setErr('Add a headline.')
    if (!safeLink(d.cta_url.trim())) return setErr('The link must be an in-app path starting with /app/ or an https:// address.')
    if (!d.placements.length) return setErr('Choose at least one placement.')
    if (d.ends_at && new Date(d.ends_at) <= new Date(d.starts_at)) return setErr('The end must be after the start.')
    setBusy(true); setErr(null)
    const body = {
      title: d.title.trim(), subtitle: d.subtitle.trim(), cta_label: d.cta_label.trim() || 'Learn more', cta_url: d.cta_url.trim(),
      media_type: d.media_path ? d.media_type : null, media_path: d.media_path, accent: d.accent, city: d.city?.trim() || null,
      starts_at: d.starts_at, ends_at: d.ends_at, placements: d.placements, status,
    }
    const r = d.id ? await supabase.from('promo_slides').update(body).eq('id', d.id) : await supabase.from('promo_slides').insert({ ...body, organization_id: orgId })
    setBusy(false)
    if (r.error) return setErr(errMsg(r.error))
    toast(status === 'submitted' ? 'Sent to VYBE for review' : 'Draft saved')
    onSaved()
  }
  const remove = async () => {
    if (!d.id || !confirm('Delete this campaign?')) return
    setBusy(true)
    const { error } = await supabase.from('promo_slides').delete().eq('id', d.id)
    if (!error && d.media_path) await supabase.storage.from('brand').remove([d.media_path]).catch(() => {})
    setBusy(false)
    error ? setErr(errMsg(error)) : onSaved()
  }
  const preview: PromoSlide = { id: 'preview', kind: 'sponsored', advertiser: orgName, title: d.title || 'Your headline', subtitle: d.subtitle, cta_label: d.cta_label || 'Learn more', cta_url: '/app', media_type: d.media_type, media_path: d.media_path, poster_path: null, focal_x: 50, focal_y: 50, accent: d.accent, sound: 'none', city: d.city, priority: 50 }

  return (
    <section className="card stack" aria-label={d.id ? 'Edit campaign' : 'New campaign'}>
      <div className="row between"><h2 className="t-section">{d.id ? 'Edit campaign' : 'New campaign'}</h2><button className="btn sm" onClick={onClose}>Back</button></div>
      {d.status === 'rejected' && d.review_note && <p className="notice" role="note"><b>VYBE’s note:</b> {d.review_note}</p>}
      <div className="oc-preview" aria-label="Preview"><div className="billboard bb-discover" style={{ pointerEvents: 'none' }}><div className="bb-stage"><SponsoredSlide s={preview} audible={false} /></div></div></div>
      <Field id="oc-title" label="Headline" hint={`${d.title.length}/90`}><input id="oc-title" className="input" maxLength={90} value={d.title} onChange={e => set({ title: e.target.value })} /></Field>
      <Field id="oc-sub" label="Supporting text (optional)" hint={`${d.subtitle.length}/160`}><input id="oc-sub" className="input" maxLength={160} value={d.subtitle} onChange={e => set({ subtitle: e.target.value })} /></Field>
      <Field id="oc-url" label="Link" hint="Your event or page on VYBE (/app/…) or an https:// address"><input id="oc-url" className="input" value={d.cta_url} onChange={e => set({ cta_url: e.target.value })} /></Field>
      <Field id="oc-cta" label="Button text" hint={`${d.cta_label.length}/24`}><input id="oc-cta" className="input" maxLength={24} value={d.cta_label} onChange={e => set({ cta_label: e.target.value })} /></Field>
      <Field id="oc-file" label="Image or video (optional)" hint="Wide images work best. Up to 10 MB for images, 50 MB for video.">
        <input id="oc-file" className="input" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
      </Field>
      {pct != null && <p className="t-meta" role="status" aria-live="polite"><progress max={100} value={pct} style={{ verticalAlign: 'middle', marginRight: 8 }} />Uploading… {pct}% (you can keep editing)</p>}
      {d.media_path && <div className="row">{d.media_type === 'image' ? <img src={promoUrl(d.media_path)} alt="" style={{ width: 120, height: 60, objectFit: 'cover', borderRadius: 8 }} /> : <span className="t-meta">Video attached</span>}<button className="btn sm danger" onClick={() => set({ media_type: null, media_path: null })}>Remove</button></div>}
      <Field id="oc-acc" label="Accent colour (used when there is no image)"><input id="oc-acc" type="color" value={d.accent} onChange={e => set({ accent: e.target.value })} /></Field>
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600, fontSize: '.875rem' }}>Where you would like it to show</legend>
        {PLACES.map(p => <label key={p.id} className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={d.placements.includes(p.id)} onChange={e => set({ placements: e.target.checked ? [...new Set([...d.placements, p.id])] : d.placements.filter(x => x !== p.id) })} /><span><b>{p.label}</b><span className="t-meta" style={{ display: 'block' }}>{p.hint}</span></span></label>)}
      </fieldset>
      <Field id="oc-city" label="City (optional)" hint="Leave empty to show everywhere"><input id="oc-city" className="input" maxLength={80} value={d.city ?? ''} onChange={e => set({ city: e.target.value })} /></Field>
      <Field id="oc-st" label="Starts"><input id="oc-st" className="input" type="datetime-local" value={toLocal(d.starts_at)} onChange={e => e.target.value && set({ starts_at: fromLocal(e.target.value)! })} /></Field>
      <Field id="oc-en" label="Ends (optional)"><input id="oc-en" className="input" type="datetime-local" value={toLocal(d.ends_at)} onChange={e => set({ ends_at: fromLocal(e.target.value) })} /></Field>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => save('submitted')}>{busy ? 'Working…' : 'Submit for review'}</button>
        <button className="btn" disabled={busy} onClick={() => save('draft')}>{d.status === 'submitted' ? 'Withdraw to draft' : 'Save draft'}</button>
        {d.id && <button className="btn danger" disabled={busy} onClick={remove}>Delete</button>}
      </div>
    </section>
  )
}
