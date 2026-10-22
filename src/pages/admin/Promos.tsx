import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { putObject } from '../../lib/media'
import { useAsync } from '../../lib/hooks'
import { HERO_EXT, HERO_IMAGE_TYPES, HERO_LIMITS, HERO_VIDEO_TYPES } from '../../lib/hero'
import { DEFAULT_SETTINGS, normaliseSettings, safeLink, promoUrl, slideLabel, type HeroSettings, type Placement, type SlideKind } from '../../lib/promos'
import { isMissingSchema } from '../../lib/tickets'
import { ErrorState, Field, Spinner, errMsg } from '../../ui'

interface Row {
  id: string; advertiser: string; title: string; subtitle: string; cta_label: string; cta_url: string
  media_type: 'image' | 'video' | null; media_path: string | null; focal_x: number; focal_y: number; accent: string
  sound: 'none' | 'chime'; city: string | null; priority: number; status: Status; starts_at: string; ends_at: string | null
  kind: SlideKind; placements: Placement[]; organization_id?: string | null; review_note?: string | null; submitted_at?: string | null
  organizations?: { name: string; slug: string } | null
}
type Status = 'draft' | 'submitted' | 'rejected' | 'live' | 'paused'
type Draft = Omit<Row, 'id'> & { id?: string }
const BLANK: Draft = { advertiser: '', title: '', subtitle: '', cta_label: 'Learn more', cta_url: '', media_type: null, media_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'chime', city: null, priority: 50, status: 'draft', starts_at: new Date().toISOString(), ends_at: null, kind: 'sponsored', placements: ['home'] }
const OLD_COLS = 'id,advertiser,title,subtitle,cta_label,cta_url,media_type,media_path,focal_x,focal_y,accent,sound,city,priority,status,starts_at,ends_at'
const COLS = `${OLD_COLS},kind,placements,organization_id,review_note,submitted_at,organizations(name,slug)`
const PLACES: { id: Placement; label: string }[] = [{ id: 'home', label: 'Home billboard' }, { id: 'discover', label: 'Discover hero' }]
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null)

/**
 * Admin → Promotions. One list of slides for both placements (Home billboard, Discover hero). Platform slides are written here;
 * organisations submit theirs from the organisation portal and they wait in the review queue. Publishing, pausing, approving
 * and rejecting are admin-only in the database too; behaviour settings go through a clamping RPC.
 */
export default function Promos() {
  const list = useAsync(async () => {
    let rows: { data: unknown[] | null; error: { code?: string; message: string } | null } = await supabase.from('promo_slides').select(COLS).order('created_at', { ascending: false })
    let upgraded = true
    if (rows.error && isMissingSchema(rows.error)) { upgraded = false; rows = await supabase.from('promo_slides').select(OLD_COLS).order('created_at', { ascending: false }) }
    const [stats, cfg] = await Promise.all([
      supabase.from('promo_stats').select('slide_id,impressions,clicks'),
      supabase.rpc('home_hero_settings'),
    ])
    if (rows.error) throw rows.error
    const totals = new Map<string, { i: number; c: number }>()
    for (const s of stats.data ?? []) { const t = totals.get(s.slide_id) ?? { i: 0, c: 0 }; t.i += s.impressions; t.c += s.clicks; totals.set(s.slide_id, t) }
    const all = ((rows.data ?? []) as unknown as Row[]).map(r => ({ ...r, kind: r.kind ?? 'sponsored', placements: r.placements ?? ['home'] }))
    return { rows: all, totals, settings: normaliseSettings(cfg.data), upgraded }
  }, [])
  const [edit, setEdit] = useState<Draft | null>(null)
  if (list.loading && !list.data) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  const { rows, totals, settings, upgraded } = list.data!
  const now = Date.now()
  const state = (r: Row) => r.status !== 'live' ? ({ submitted: 'waiting for review', rejected: 'rejected' } as Record<string, string>)[r.status] ?? r.status : new Date(r.starts_at).getTime() > now ? 'scheduled' : r.ends_at && new Date(r.ends_at).getTime() <= now ? 'ended' : 'live now'
  const queue = rows.filter(r => r.status === 'submitted')
  const others = rows.filter(r => r.status !== 'submitted')

  return (
    <div className="stack">
      <div className="notice"><b>Promotions.</b> Two placements: the <b>Home billboard</b> (trending plans near each member play first, slides are interleaved) and the <b>Discover hero</b> (slides only). Every slide is labelled: <i>Sponsored · advertiser</i> for paid placements, <i>From VYBE</i> for house promotions, <i>VYBE announcement</i> for news. Members see only slides that are <b>live</b> and inside their dates; with none live, each placement shows VYBE’s own house slide.</div>
      {!upgraded && <p className="notice" role="status">This database does not have the campaigns update yet (supabase/migrations/…016_campaigns.sql): slides show on Home only, and organisation submissions are off.</p>}
      <Settings value={settings} reload={list.reload} />
      <section aria-labelledby="pr-queue">
        <h2 id="pr-queue" className="t-section">Review queue{queue.length > 0 && <span className="t-meta" style={{ fontWeight: 600 }}> · {queue.length} waiting</span>}</h2>
        {!queue.length ? <p className="t-meta">No organisation campaigns are waiting for review.</p> : (
          <div className="list">
            {queue.map(r => <ReviewRow key={r.id} r={r} onOpen={() => setEdit(r)} onDone={list.reload} />)}
          </div>
        )}
      </section>
      <div className="row between"><h2 className="t-section">Slides</h2><button className="btn primary" onClick={() => setEdit({ ...BLANK, starts_at: new Date().toISOString() })}>New slide</button></div>
      {!others.length ? <p className="t-meta">No slides yet. Trending plans still play on Home, and both placements show VYBE’s house slide.</p> : (
        <div className="list">
          {others.map(r => {
            const t = totals.get(r.id)
            return (
              <div key={r.id} className="item row" style={{ alignItems: 'center', gap: 12 }}>
                <span aria-hidden style={{ width: 14, height: 40, borderRadius: 4, background: r.accent }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t-name clamp-1">{r.title}</div>
                  <div className="t-meta">{slideLabel(r)}{r.organizations ? ` (submitted by ${r.organizations.name})` : ''} · {r.placements.map(p => PLACES.find(x => x.id === p)?.label).join(' + ')} · {state(r)} · priority {r.priority}{r.city ? ` · ${r.city}` : ''} · {t?.i ?? 0} views · {t?.c ?? 0} clicks{t?.i ? ` (${((t.c / t.i) * 100).toFixed(1)}%)` : ''}</div>
                  {r.status === 'rejected' && r.review_note && <div className="t-meta">Reason given: {r.review_note}</div>}
                </div>
                <button className="btn sm" onClick={() => setEdit(r)}>Edit</button>
              </div>
            )
          })}
        </div>
      )}
      {edit && <Editor key={edit.id ?? 'new'} initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); list.reload() }} />}
    </div>
  )
}

/** One submitted organisation campaign: approve (publishes inside its dates) or reject with a reason the organisation sees. */
function ReviewRow({ r, onOpen, onDone }: { r: Row; onOpen: () => void; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const decide = async (status: 'live' | 'rejected') => {
    if (status === 'rejected' && !note.trim()) return setErr('Give the organisation a reason.')
    setBusy(true); setErr(null)
    const { error } = await supabase.from('promo_slides').update(status === 'live' ? { status } : { status, review_note: note.trim().slice(0, 300) }).eq('id', r.id)
    setBusy(false)
    if (error) return setErr(errMsg(error))
    onDone()
  }
  return (
    <div className="item stack" style={{ gap: 8 }} aria-label={`Review ${r.title}`}>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        {r.media_path && r.media_type === 'image' ? <img src={promoUrl(r.media_path)} alt="" style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 8 }} /> : <span aria-hidden style={{ width: 14, height: 40, borderRadius: 4, background: r.accent }} />}
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="t-name clamp-1">{r.title}</div>
          <div className="t-meta">{r.organizations?.name ?? r.advertiser} · {r.placements.map(p => PLACES.find(x => x.id === p)?.label).join(' + ')} · {new Date(r.starts_at).toLocaleDateString()}{r.ends_at ? `–${new Date(r.ends_at).toLocaleDateString()}` : ''} · links to {r.cta_url}</div>
        </div>
        <button className="btn sm" onClick={onOpen}>Open</button>
      </div>
      <Field id={`rv-${r.id}`} label="Reason if rejecting (the organisation sees this)"><input id={`rv-${r.id}`} className="input" maxLength={300} value={note} onChange={e => setNote(e.target.value)} /></Field>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row"><button className="btn primary sm" disabled={busy} onClick={() => decide('live')}>Approve and publish</button><button className="btn danger sm" disabled={busy} onClick={() => decide('rejected')}>Reject</button></div>
    </div>
  )
}

function Settings({ value, reload }: { value: HeroSettings; reload: () => void }) {
  const [s, setS] = useState<HeroSettings>(value)
  const [msg, setMsg] = useState<string | null>(null)
  const save = async () => {
    setMsg(null)
    const { error } = await supabase.rpc('save_home_hero_settings', { p: s })
    if (error) return setMsg(errMsg(error))
    setMsg('Saved.'); reload()
  }
  return (
    <section className="card">
      <h2 className="t-section">Behaviour</h2>
      <label className="row" style={{ gap: 8, margin: '8px 0' }}><input type="checkbox" checked={s.trending_enabled} onChange={e => setS({ ...s, trending_enabled: e.target.checked })} /> Play trending plans first</label>
      <Field id="bb-max" label={`Trending plans per rotation: ${s.max_trending}`} hint="0–10"><input id="bb-max" type="range" min={0} max={10} value={s.max_trending} onChange={e => setS({ ...s, max_trending: Number(e.target.value) })} /></Field>
      <Field id="bb-ms" label={`Seconds per slide: ${(s.autoplay_ms / 1000).toFixed(0)}`} hint="3–20"><input id="bb-ms" type="range" min={3000} max={20000} step={1000} value={s.autoplay_ms} onChange={e => setS({ ...s, autoplay_ms: Number(e.target.value) })} /></Field>
      <Field id="bb-ev" label={`A sponsored slide after every ${s.sponsored_every - 1 || 1} trending`} hint="Lower = more sponsored slides"><input id="bb-ev" type="range" min={2} max={6} value={s.sponsored_every} onChange={e => setS({ ...s, sponsored_every: Number(e.target.value) })} /></Field>
      <div className="row"><button className="btn primary" onClick={save}>Save behaviour</button><button className="btn" onClick={() => setS(DEFAULT_SETTINGS)}>Reset</button>{msg && <span className="t-meta" role="status">{msg}</span>}</div>
    </section>
  )
}

function Editor({ initial, onClose, onSaved }: { initial: Draft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))

  const upload = async (file?: File) => {
    if (!file) return
    const kind = HERO_IMAGE_TYPES.includes(file.type) ? 'image' : HERO_VIDEO_TYPES.includes(file.type) ? 'video' : null
    if (!kind) return setErr('Use a JPG, PNG or WebP image, or an MP4 or WebM video.')
    if (file.size > (kind === 'image' ? HERO_LIMITS.imageBytes : HERO_LIMITS.videoBytes)) return setErr(kind === 'image' ? 'Images can be up to 10 MB.' : 'Videos can be up to 50 MB.')
    setBusy(true); setErr(null)
    const path = `promo/${crypto.randomUUID()}.${HERO_EXT[file.type]}`
    setPct(0)
    try { await putObject('brand', path, file, file.type, { onProgress: (a, b) => setPct(Math.round((a / b) * 100)) }) }
    catch (e) { setBusy(false); setPct(null); return setErr(`Upload failed: ${(e as Error).message}`) }
    setBusy(false); setPct(null)
    set({ media_type: kind, media_path: path })
  }

  const save = async () => {
    if (!safeLink(d.cta_url)) return setErr('The link must be an in-app path starting with /app/ or an https:// address.')
    setBusy(true); setErr(null)
    const body = {
      advertiser: d.advertiser.trim(), title: d.title.trim(), subtitle: d.subtitle.trim(), cta_label: d.cta_label.trim() || 'Learn more', cta_url: d.cta_url.trim(),
      media_type: d.media_path ? d.media_type : null, media_path: d.media_path, poster_path: null, focal_x: d.focal_x, focal_y: d.focal_y, accent: d.accent, sound: d.sound,
      city: d.city?.trim() || null, priority: d.priority, status: d.status, starts_at: d.starts_at, ends_at: d.ends_at,
      ...(d.organization_id ? {} : { kind: d.kind }), placements: d.placements.length ? d.placements : ['home'],
    }
    const r = d.id ? await supabase.from('promo_slides').update({ ...body, updated_at: new Date().toISOString() }).eq('id', d.id) : await supabase.from('promo_slides').insert(body)
    setBusy(false)
    if (r.error) return setErr(errMsg(r.error))
    onSaved()
  }
  const remove = async () => {
    if (!d.id || !confirm('Delete this slide and its statistics?')) return
    setBusy(true)
    const { error } = await supabase.from('promo_slides').delete().eq('id', d.id)
    if (!error && d.media_path) await supabase.storage.from('brand').remove([d.media_path]).catch(() => {})
    setBusy(false)
    error ? setErr(errMsg(error)) : onSaved()
  }

  return (
    <section className="card" aria-label={d.id ? 'Edit slide' : 'New slide'}>
      <h2 className="t-section">{d.id ? 'Edit slide' : 'New slide'}</h2>
      <Field id="pr-title" label="Headline" hint={`${d.title.length}/90`}><input id="pr-title" className="input" maxLength={90} value={d.title} onChange={e => set({ title: e.target.value })} /></Field>
      <Field id="pr-sub" label="Supporting text (optional)" hint={`${d.subtitle.length}/160`}><input id="pr-sub" className="input" maxLength={160} value={d.subtitle} onChange={e => set({ subtitle: e.target.value })} /></Field>
      {d.organization_id
        ? <p className="t-meta">Submitted by an organisation: always labelled “Sponsored · {d.advertiser}”.</p>
        : <>
            <Field id="pr-kind" label="What this is (shown on the slide)"><select id="pr-kind" className="select" value={d.kind} onChange={e => set({ kind: e.target.value as SlideKind })}><option value="sponsored">Paid placement: “Sponsored · advertiser”</option><option value="house">VYBE’s own promotion: “From VYBE”</option><option value="announcement">Platform news: “VYBE announcement”</option></select></Field>
            {d.kind === 'sponsored' && <Field id="pr-adv" label="Advertiser (shown as “Sponsored · name”)"><input id="pr-adv" className="input" maxLength={80} value={d.advertiser} onChange={e => set({ advertiser: e.target.value })} /></Field>}
          </>}
      <fieldset className="field" style={{ border: 0, padding: 0 }}><legend style={{ fontWeight: 600, fontSize: '.875rem' }}>Where it shows</legend>
        {PLACES.map(p => <label key={p.id} className="row" style={{ gap: 8 }}><input type="checkbox" checked={d.placements.includes(p.id)} onChange={e => set({ placements: e.target.checked ? [...new Set([...d.placements, p.id])] : d.placements.filter(x => x !== p.id) })} /> {p.label}</label>)}
      </fieldset>
      <Field id="pr-url" label="Link" hint="/app/discover or https://…"><input id="pr-url" className="input" value={d.cta_url} onChange={e => set({ cta_url: e.target.value })} /></Field>
      <Field id="pr-cta" label="Button text" hint={`${d.cta_label.length}/24`}><input id="pr-cta" className="input" maxLength={24} value={d.cta_label} onChange={e => set({ cta_label: e.target.value })} /></Field>
      <Field id="pr-file" label="Image or video" hint="Wide images work best. Video loops muted; members can turn sound on.">
        <input id="pr-file" className="input" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
      </Field>
      {pct != null && <p className="t-meta" role="status" aria-live="polite"><progress max={100} value={pct} style={{ verticalAlign: 'middle', marginRight: 8 }} />Uploading… {pct}% (you can keep editing)</p>}
      {d.media_path && <div className="row" style={{ marginBottom: 12 }}>
        {d.media_type === 'image' ? <img src={promoUrl(d.media_path)} alt="" style={{ width: 120, height: 60, objectFit: 'cover', objectPosition: `${d.focal_x}% ${d.focal_y}%`, borderRadius: 8 }} /> : <span className="t-meta">Video attached</span>}
        <button className="btn sm danger" onClick={() => set({ media_type: null, media_path: null })}>Remove</button>
      </div>}
      {d.media_path && <>
        <Field id="pr-fx" label={`Focal point, horizontal: ${d.focal_x}%`}><input id="pr-fx" type="range" min={0} max={100} value={d.focal_x} onChange={e => set({ focal_x: Number(e.target.value) })} /></Field>
        <Field id="pr-fy" label={`Focal point, vertical: ${d.focal_y}%`}><input id="pr-fy" type="range" min={0} max={100} value={d.focal_y} onChange={e => set({ focal_y: Number(e.target.value) })} /></Field>
      </>}
      <Field id="pr-acc" label="Accent colour (used when there is no media)"><input id="pr-acc" type="color" value={d.accent} onChange={e => set({ accent: e.target.value })} /></Field>
      <Field id="pr-snd" label="Sound"><select id="pr-snd" className="select" value={d.sound} onChange={e => set({ sound: e.target.value as Draft['sound'] })}><option value="chime">Soft chime when the slide appears</option><option value="none">Silent</option></select></Field>
      <Field id="pr-city" label="City (optional)" hint="Leave empty to show everywhere"><input id="pr-city" className="input" maxLength={80} value={d.city ?? ''} onChange={e => set({ city: e.target.value })} /></Field>
      <Field id="pr-pri" label={`Priority: ${d.priority}`} hint="Higher plays earlier"><input id="pr-pri" type="range" min={0} max={100} value={d.priority} onChange={e => set({ priority: Number(e.target.value) })} /></Field>
      <Field id="pr-st" label="Starts"><input id="pr-st" className="input" type="datetime-local" value={toLocal(d.starts_at)} onChange={e => e.target.value && set({ starts_at: fromLocal(e.target.value)! })} /></Field>
      <Field id="pr-en" label="Ends (optional)"><input id="pr-en" className="input" type="datetime-local" value={toLocal(d.ends_at)} onChange={e => set({ ends_at: fromLocal(e.target.value) })} /></Field>
      <Field id="pr-status" label="Status"><select id="pr-status" className="select" value={d.status} onChange={e => set({ status: e.target.value as Status })}><option value="draft">Draft (hidden)</option>{d.status === 'submitted' && <option value="submitted">Waiting for review</option>}{d.status === 'rejected' && <option value="rejected">Rejected</option>}<option value="live">Live (inside its dates)</option><option value="paused">Paused</option></select></Field>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || d.title.trim().length < 2 || !d.placements.length} onClick={save}>{busy ? 'Working…' : 'Save slide'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        {d.id && <button className="btn danger" disabled={busy} onClick={remove}>Delete</button>}
      </div>
    </section>
  )
}
