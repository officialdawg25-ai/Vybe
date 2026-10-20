import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { HERO_EXT, HERO_IMAGE_TYPES, HERO_LIMITS, HERO_VIDEO_TYPES } from '../../lib/hero'
import { DEFAULT_SETTINGS, normaliseSettings, safeLink, promoUrl, type HeroSettings } from '../../lib/promos'
import { ErrorState, Field, Spinner, errMsg } from '../../ui'

interface Row {
  id: string; advertiser: string; title: string; subtitle: string; cta_label: string; cta_url: string
  media_type: 'image' | 'video' | null; media_path: string | null; focal_x: number; focal_y: number; accent: string
  sound: 'none' | 'chime'; city: string | null; priority: number; status: 'draft' | 'live' | 'paused'; starts_at: string; ends_at: string | null
}
type Draft = Omit<Row, 'id'> & { id?: string }
const BLANK: Draft = { advertiser: '', title: '', subtitle: '', cta_label: 'Learn more', cta_url: '', media_type: null, media_path: null, focal_x: 50, focal_y: 50, accent: '#6a4cff', sound: 'chime', city: null, priority: 50, status: 'draft', starts_at: new Date().toISOString(), ends_at: null }
const COLS = 'id,advertiser,title,subtitle,cta_label,cta_url,media_type,media_path,focal_x,focal_y,accent,sound,city,priority,status,starts_at,ends_at'
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null)

/** Admin → Home billboard. Slides are rows (RLS: admin-only writes); behaviour settings go through a clamping RPC. */
export default function Promos() {
  const list = useAsync(async () => {
    const [rows, stats, cfg] = await Promise.all([
      supabase.from('promo_slides').select(COLS).order('created_at', { ascending: false }),
      supabase.from('promo_stats').select('slide_id,impressions,clicks'),
      supabase.rpc('home_hero_settings'),
    ])
    if (rows.error) throw rows.error
    const totals = new Map<string, { i: number; c: number }>()
    for (const s of stats.data ?? []) { const t = totals.get(s.slide_id) ?? { i: 0, c: 0 }; t.i += s.impressions; t.c += s.clicks; totals.set(s.slide_id, t) }
    return { rows: (rows.data ?? []) as Row[], totals, settings: normaliseSettings(cfg.data) }
  }, [])
  const [edit, setEdit] = useState<Draft | null>(null)
  if (list.loading && !list.data) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  const { rows, totals, settings } = list.data!
  const now = Date.now()
  const state = (r: Row) => r.status !== 'live' ? r.status : new Date(r.starts_at).getTime() > now ? 'scheduled' : r.ends_at && new Date(r.ends_at).getTime() <= now ? 'ended' : 'live now'

  return (
    <div className="stack">
      <div className="notice"><b>Home billboard.</b> The screen between the header and the composer. Trending plans near each member play first; the slides below are interleaved as sponsored placements. Members see only slides that are <b>live</b> and inside their dates.</div>
      <Settings value={settings} reload={list.reload} />
      <div className="row between"><h2 className="t-section">Slides</h2><button className="btn primary" onClick={() => setEdit({ ...BLANK, starts_at: new Date().toISOString() })}>New slide</button></div>
      {!rows.length ? <p className="t-meta">No slides yet. Trending plans still play without them.</p> : (
        <div className="list">
          {rows.map(r => {
            const t = totals.get(r.id)
            return (
              <div key={r.id} className="item row" style={{ alignItems: 'center', gap: 12 }}>
                <span aria-hidden style={{ width: 14, height: 40, borderRadius: 4, background: r.accent }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="t-name clamp-1">{r.title}</div>
                  <div className="t-meta">{r.advertiser || 'No advertiser'} · {state(r)} · priority {r.priority}{r.city ? ` · ${r.city}` : ''} · {t?.i ?? 0} views · {t?.c ?? 0} clicks{t?.i ? ` (${((t.c / t.i) * 100).toFixed(1)}%)` : ''}</div>
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
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))

  const upload = async (file?: File) => {
    if (!file) return
    const kind = HERO_IMAGE_TYPES.includes(file.type) ? 'image' : HERO_VIDEO_TYPES.includes(file.type) ? 'video' : null
    if (!kind) return setErr('Use a JPG, PNG or WebP image, or an MP4 or WebM video.')
    if (file.size > (kind === 'image' ? HERO_LIMITS.imageBytes : HERO_LIMITS.videoBytes)) return setErr(kind === 'image' ? 'Images can be up to 10 MB.' : 'Videos can be up to 50 MB.')
    setBusy(true); setErr(null)
    const path = `promo/${crypto.randomUUID()}.${HERO_EXT[file.type]}`
    const up = await supabase.storage.from('brand').upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false })
    setBusy(false)
    if (up.error) return setErr(`Upload failed: ${up.error.message}`)
    set({ media_type: kind, media_path: path })
  }

  const save = async () => {
    if (!safeLink(d.cta_url)) return setErr('The link must be an in-app path starting with /app/ or an https:// address.')
    setBusy(true); setErr(null)
    const body = {
      advertiser: d.advertiser.trim(), title: d.title.trim(), subtitle: d.subtitle.trim(), cta_label: d.cta_label.trim() || 'Learn more', cta_url: d.cta_url.trim(),
      media_type: d.media_path ? d.media_type : null, media_path: d.media_path, poster_path: null, focal_x: d.focal_x, focal_y: d.focal_y, accent: d.accent, sound: d.sound,
      city: d.city?.trim() || null, priority: d.priority, status: d.status, starts_at: d.starts_at, ends_at: d.ends_at,
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
      <Field id="pr-adv" label="Advertiser (shown as “Sponsored · name”)"><input id="pr-adv" className="input" maxLength={80} value={d.advertiser} onChange={e => set({ advertiser: e.target.value })} /></Field>
      <Field id="pr-url" label="Link" hint="/app/discover or https://…"><input id="pr-url" className="input" value={d.cta_url} onChange={e => set({ cta_url: e.target.value })} /></Field>
      <Field id="pr-cta" label="Button text" hint={`${d.cta_label.length}/24`}><input id="pr-cta" className="input" maxLength={24} value={d.cta_label} onChange={e => set({ cta_label: e.target.value })} /></Field>
      <Field id="pr-file" label="Image or video" hint="Wide images work best. Video loops muted; members can turn sound on.">
        <input id="pr-file" className="input" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
      </Field>
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
      <Field id="pr-status" label="Status"><select id="pr-status" className="select" value={d.status} onChange={e => set({ status: e.target.value as Draft['status'] })}><option value="draft">Draft (hidden)</option><option value="live">Live (inside its dates)</option><option value="paused">Paused</option></select></Field>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || d.title.trim().length < 2} onClick={save}>{busy ? 'Working…' : 'Save slide'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        {d.id && <button className="btn danger" disabled={busy} onClick={remove}>Delete</button>}
      </div>
    </section>
  )
}
