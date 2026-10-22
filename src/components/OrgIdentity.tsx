import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { useSubmit } from '../lib/hooks'
import { discardUploads, uploadMedia, validateMedia } from '../lib/media'
import { Avatar, Field, errMsg, toast, useSigned } from '../ui'

export interface OrgIdentityRow {
  id: string; name: string; slug: string; description: string
  avatar_path: string | null; cover_path: string | null; website: string | null; links: { label: string; url: string }[]; location: string | null
}
interface Pick { file: File; preview: string; pct: number; job: Promise<string>; path?: string; failed?: string; ctrl: AbortController }

const https = (s: string) => /^https:\/\/\S{3,200}$/.test(s)

/**
 * The organisation's public identity. Logo and cover start uploading the moment they are picked (with a local preview and
 * progress); Save waits for them, then writes everything in one update. The server checks the role, that the images are
 * the saver's own uploads, and that links are https; nothing here is only a client-side rule.
 */
export function OrgIdentity({ org, identity, onSaved }: { org: OrgIdentityRow; identity: boolean; onSaved: () => void }) {
  const { uid } = useAuth()
  const [name, setName] = useState(org.name)
  const [description, setDescription] = useState(org.description)
  const [website, setWebsite] = useState(org.website ?? '')
  const [location, setLocation] = useState(org.location ?? '')
  const [links, setLinks] = useState(org.links ?? [])
  const [logo, setLogo] = useState<Pick | null>(null)
  const [cover, setCover] = useState<Pick | null>(null)
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const saved = useRef(false)
  const live = useRef({ logo, cover })
  live.current = { logo, cover }
  // Leaving without saving cancels uploads in flight and removes ones that finished, so nothing is left behind.
  useEffect(() => () => {
    if (saved.current) return
    for (const p of [live.current.logo, live.current.cover]) { if (!p) continue; p.ctrl.abort(); URL.revokeObjectURL(p.preview); if (p.path) discardUploads('media', [p.path]) }
  }, [])

  const pick = (file: File | undefined, set: (p: Pick | null | ((p: Pick | null) => Pick | null)) => void, prev: Pick | null) => {
    if (!file || !uid) return
    const check = validateMedia(file)
    if (!check.ok || check.type !== 'image') return setErr(check.ok ? 'Choose an image (JPEG, PNG, WebP or GIF).' : check.error)
    setErr('')
    if (prev) { prev.ctrl.abort(); URL.revokeObjectURL(prev.preview); if (prev.path) discardUploads('media', [prev.path]) }
    const ctrl = new AbortController()
    const p: Pick = { file, preview: URL.createObjectURL(file), pct: 0, ctrl, job: Promise.resolve('') }
    p.job = uploadMedia(uid, file, { signal: ctrl.signal, first: true, onProgress: (s, t) => set(x => (x && x.ctrl === ctrl ? { ...x, pct: Math.round(s / t * 100) } : x)) })
      .then(r => { set(x => (x && x.ctrl === ctrl ? { ...x, path: r.path, pct: 100 } : x)); return r.path })
      .catch(e => { set(x => (x && x.ctrl === ctrl ? { ...x, failed: errMsg(e) } : x)); throw e })
    p.job.catch(() => { /* shown on the tile */ })
    set(p)
  }

  const save = () => submit(async () => {
    setErr('')
    if (name.trim().length < 2) return setErr('Enter a name.')
    const w = website.trim()
    if (w && !https(w)) return setErr('The website must start with https://')
    const ls = links.map(l => ({ label: l.label.trim(), url: l.url.trim() })).filter(l => l.label || l.url)
    if (ls.some(l => !l.label || l.label.length > 40 || !https(l.url))) return setErr('Each link needs a short label and an address starting with https://')
    let logoPath: string | undefined, coverPath: string | undefined
    try {
      if (logo) logoPath = await logo.job
      if (cover) coverPath = await cover.job
    } catch { return setErr('An image did not upload. Pick it again, or remove it.') }
    const patch: Record<string, unknown> = { name: name.trim(), description: description.trim() }
    if (identity) Object.assign(patch, { website: w || null, location: location.trim() || null, links: ls })
    if (logoPath) patch.avatar_path = logoPath
    if (coverPath && identity) patch.cover_path = coverPath
    const { error } = await supabase.from('organizations').update(patch).eq('id', org.id)
    if (error) return setErr(errMsg(error))
    saved.current = true
    // The replaced images are no longer referenced; remove them when they were ours (others' files are not ours to delete).
    const old = [logoPath && org.avatar_path, coverPath && org.cover_path].filter((p): p is string => Boolean(p && uid && p.startsWith(`${uid}/`)))
    if (old.length) discardUploads('media', old)
    toast('Saved'); onSaved()
  })

  const uploading = [logo, cover].filter(p => p && !p.path && !p.failed) as Pick[]
  return (
    <section aria-label="Identity and branding" className="org-id">
      <CoverEdit org={org} pick={cover} disabled={!identity} onPick={f => pick(f, setCover, cover)} onClear={() => { if (cover) { cover.ctrl.abort(); if (cover.path) discardUploads('media', [cover.path]) } setCover(null) }} />
      <div className="row" style={{ gap: 12, alignItems: 'center', margin: '12px 0' }}>
        <LogoEdit org={org} pick={logo} onPick={f => pick(f, setLogo, logo)} />
        <p className="t-meta grow">Logo and cover show on your page, your events and in Discover. Square logos work best; covers are shown wide (about 3:1).</p>
      </div>
      <Field id="s-name" label="Name"><input id="s-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></Field>
      <Field id="s-desc" label="About"><textarea id="s-desc" className="textarea" value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></Field>
      {identity ? (
        <>
          <Field id="s-web" label="Website" hint="Must start with https://"><input id="s-web" className="input" type="url" inputMode="url" value={website} maxLength={200} placeholder="https://" onChange={e => setWebsite(e.target.value)} /></Field>
          <Field id="s-loc" label="Location" hint="A town or venue area, shown on your page"><input id="s-loc" className="input" value={location} maxLength={80} onChange={e => setLocation(e.target.value)} /></Field>
          <fieldset className="org-links">
            <legend className="t-name">Links <span className="t-meta">({links.length} of 5)</span></legend>
            {links.map((l, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Field id={`l-lab-${i}`} label="Label"><input id={`l-lab-${i}`} className="input" value={l.label} maxLength={40} placeholder="Instagram" onChange={e => setLinks(x => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} /></Field>
                <div className="grow"><Field id={`l-url-${i}`} label="Address"><input id={`l-url-${i}`} className="input" type="url" value={l.url} maxLength={200} placeholder="https://" onChange={e => setLinks(x => x.map((y, j) => (j === i ? { ...y, url: e.target.value } : y)))} /></Field></div>
                <button type="button" className="icon-btn" style={{ marginBottom: 16 }} aria-label={`Remove link ${i + 1}`} onClick={() => setLinks(x => x.filter((_, j) => j !== i))}><Trash2 size={18} /></button>
              </div>
            ))}
            {links.length < 5 && <button type="button" className="btn sm" onClick={() => setLinks(x => [...x, { label: '', url: '' }])}><Plus size={16} aria-hidden /> Add a link</button>}
          </fieldset>
        </>
      ) : <p className="notice" role="status">Cover, website, links and location need the latest database update (migration 19).</p>}
      <p className="t-meta" style={{ margin: '12px 0' }}>The handle (@{org.slug}) and verification are fixed and can’t be changed here.</p>
      {uploading.length > 0 && <p className="t-meta" role="status">Uploading {uploading.map(p => `${p.pct}%`).join(', ')}… you can keep editing; Save waits for it.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary" disabled={busy} onClick={save}>{busy && uploading.length ? 'Finishing upload…' : busy ? 'Saving…' : 'Save changes'}</button>
    </section>
  )
}

function CoverEdit({ org, pick, disabled, onPick, onClear }: { org: OrgIdentityRow; pick: Pick | null; disabled: boolean; onPick: (f?: File) => void; onClear: () => void }) {
  const current = useSigned(org.cover_path)
  const src = pick?.preview ?? current
  return (
    <div className="org-cover-edit" style={src ? { backgroundImage: `url(${src})` } : undefined}>
      {!disabled && (
        <label className="btn sm">
          <ImagePlus size={16} aria-hidden /> {src ? 'Change cover' : 'Add a cover'}
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" aria-label="Choose a cover image" onChange={e => { onPick(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      )}
      {pick && <button type="button" className="btn sm ghost" onClick={onClear}>Undo</button>}
      {pick && <Progress p={pick} />}
    </div>
  )
}

function LogoEdit({ org, pick, onPick }: { org: OrgIdentityRow; pick: Pick | null; onPick: (f?: File) => void }) {
  return (
    <label className="org-logo-edit" aria-label="Choose a logo">
      {pick ? <img src={pick.preview} alt="" className="avatar lg" /> : <Avatar path={org.avatar_path} name={org.name} size="lg" kind="org" />}
      <span className="org-logo-cta"><ImagePlus size={16} aria-hidden /></span>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={e => { onPick(e.target.files?.[0]); e.target.value = '' }} />
      {pick && <Progress p={pick} />}
    </label>
  )
}

function Progress({ p }: { p: Pick }) {
  if (p.failed) return <span className="org-up failed" role="alert">Not uploaded: {p.failed}</span>
  if (p.path) return <span className="org-up done">Ready</span>
  return <progress className="cp-prog" max={100} value={p.pct} aria-label="Upload progress" />
}
