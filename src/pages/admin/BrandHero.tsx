import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { DEFAULT_HERO, HERO_LIMITS, heroPath, normaliseHero, validateHeroFile, type AuthHero } from '../../lib/hero'
import { HeroContent, HeroMedia } from '../../brand/HeroMedia'
import { ErrorState, Field, Spinner, errMsg } from '../../ui'

interface Row { draft: unknown; published: unknown; updated_at: string; published_at: string | null }
const DRAFT = 'brand-draft'
const PUBLIC = 'brand'

/** Downscales very large photos before upload so the sign-in page stays light. */
async function optimiseImage(file: File): Promise<File> {
  if (file.type === 'image/gif' || file.size < 1.5 * 1024 * 1024) return file
  try {
    const bmp = await createImageBitmap(file)
    const w = Math.min(2400, bmp.width)
    if (w === bmp.width && file.size < 4 * 1024 * 1024) return file
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round((bmp.height * w) / bmp.width)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/webp', 0.85))
    return blob && blob.size < file.size ? new File([blob], 'hero.webp', { type: 'image/webp' }) : file
  } catch { return file }
}

/** First-frame JPEG for a video, so the sign-in page has a poster while the video loads (or if it cannot play). */
function capturePoster(file: File): Promise<Blob | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url
    const finish = (b: Blob | null) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(b) }
    const timer = setTimeout(() => finish(null), 8000)
    v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2) }
    v.onerror = () => finish(null)
    v.onseeked = () => {
      const w = Math.min(1280, v.videoWidth || 1280)
      const c = document.createElement('canvas'); c.width = w; c.height = Math.round((w * (v.videoHeight || 720)) / (v.videoWidth || 1280))
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
      c.toBlob(finish, 'image/jpeg', 0.82)
    }
  })
}

const pathsOf = (h: Pick<AuthHero, 'path' | 'poster_path'> | null | undefined) => [h?.path, h?.poster_path].filter((p): p is string => Boolean(p))
const toConfig = (h: AuthHero) => ({ ...h, media_type: h.media_type ?? null, path: h.path ?? null, poster_path: h.poster_path ?? null })

/** Brand & Experience → Authentication Hero. Admin-only; every write goes through RPCs that re-check the role. */
export default function BrandHero() {
  const row = useAsync(async () => {
    const { data, error } = await supabase.from('site_settings').select('draft,published,updated_at,published_at').eq('key', 'auth_hero').maybeSingle()
    if (error) throw error
    return (data ?? null) as Row | null
  }, [])
  // Reloads after save/publish must not unmount the editor (it would lose its status message and unsaved edits).
  const first = useRef(true)
  if (!row.loading) first.current = false
  if (first.current) return <Spinner />
  if (row.error) return <ErrorState message={row.error} onRetry={row.reload} />
  return <Editor row={row.data} reload={row.reload} />
}

function Editor({ row, reload }: { row: Row | null; reload: () => void }) {
  const published = normaliseHero(row?.published)
  const saved = normaliseHero(row?.draft) ?? published ?? { ...DEFAULT_HERO, headline: '', body: '' }
  const [hero, setHero] = useState<AuthHero>(saved)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null)
  const [urls, setUrls] = useState<{ src?: string; poster?: string }>({})
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  // Draft-bucket files this editor knows about; anything no longer referenced is removed after a successful save.
  const known = useRef(new Set<string>([...pathsOf(saved)]))
  const savedKey = JSON.stringify(toConfig(saved))
  const dirty = JSON.stringify(toConfig(hero)) !== savedKey
  const isLive = Boolean(published) && JSON.stringify(toConfig(published!)) === JSON.stringify(toConfig(hero))

  // Draft media is private: preview through short-lived signed URLs.
  useEffect(() => {
    let live = true
    const sign = async (p?: string) => (p ? (await supabase.storage.from(DRAFT).createSignedUrl(p, 3600)).data?.signedUrl : undefined)
    Promise.all([sign(hero.path), sign(hero.poster_path)]).then(([src, poster]) => live && setUrls({ src, poster }))
    return () => { live = false }
  }, [hero.path, hero.poster_path])

  const set = (patch: Partial<AuthHero>) => setHero(h => ({ ...h, ...patch }))
  const run = async (label: string, fn: () => Promise<string | void>) => {
    if (busy) return
    setBusy(label); setMsg(null)
    try { const ok = await fn(); if (ok) setMsg({ kind: 'ok', text: ok }) } catch (e) { setMsg({ kind: 'err', text: errMsg(e) }) } finally { setBusy(null) }
  }
  const cleanup = async (bucket: string, paths: string[]) => { if (paths.length) await supabase.storage.from(bucket).remove(paths).catch(() => {}) }

  const upload = (file: File | undefined) => run('upload', async () => {
    if (!file) return
    const check = validateHeroFile(file)
    if (!check.ok) throw new Error(check.error)
    const body = check.kind === 'image' ? await optimiseImage(file) : file
    const path = heroPath(body.type)
    const up = await supabase.storage.from(DRAFT).upload(path, body, { contentType: body.type, upsert: false, cacheControl: '31536000' })
    if (up.error) throw new Error(`Upload failed: ${up.error.message}. Your current hero is unchanged.`)
    known.current.add(path)
    let poster: string | undefined
    if (check.kind === 'video') {
      const blob = await capturePoster(file)
      if (blob) {
        const pp = heroPath('image/jpeg')
        const pr = await supabase.storage.from(DRAFT).upload(pp, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' })
        if (!pr.error) { poster = pp; known.current.add(pp) }
      }
    }
    set({ media_type: check.kind, path, poster_path: poster })
    return 'Uploaded. Review the preview, then save the draft or publish.'
  })

  const persist = async (h: AuthHero) => {
    const { error } = await supabase.rpc('save_auth_hero_draft', { cfg: toConfig(h) })
    if (error) throw error
    const keep = new Set(pathsOf(h))
    const orphans = [...known.current].filter(p => !keep.has(p))
    orphans.forEach(p => known.current.delete(p))
    await cleanup(DRAFT, orphans)
  }

  const saveDraft = () => run('save', async () => { await persist(hero); reload(); return 'Draft saved. Visitors still see the published hero.' })

  const publish = () => run('publish', async () => {
    if (!hero.path && !hero.headline && !hero.body) throw new Error('Add media or some text before publishing, or use “Restore default”.')
    await persist(hero)
    // Copy into the public bucket first; the server refuses to publish unless the files are there.
    for (const p of pathsOf(hero)) {
      const { error } = await supabase.storage.from(DRAFT).copy(p, p, { destinationBucket: PUBLIC })
      if (error && !/exist|duplicate/i.test(error.message)) throw new Error(`Could not copy media to the public bucket: ${error.message}. The previous hero is still live.`)
    }
    const { error } = await supabase.rpc('publish_auth_hero')
    if (error) throw error
    const old = pathsOf(published).filter(p => !pathsOf(hero).includes(p))
    await cleanup(PUBLIC, old)
    reload()
    return 'Published. The sign-in and landing pages now show this hero.'
  })

  const unpublish = () => run('unpublish', async () => {
    const { error } = await supabase.rpc('unpublish_auth_hero')
    if (error) throw error
    await cleanup(PUBLIC, pathsOf(published))
    reload()
    return 'Unpublished. Visitors see the VYBE default hero; your draft is kept.'
  })

  const restore = () => run('restore', async () => {
    if (!confirm('Restore the VYBE default hero? This clears the draft and unpublishes the current hero.')) return
    const { error } = await supabase.rpc('reset_auth_hero')
    if (error) throw error
    await cleanup(PUBLIC, pathsOf(published))
    await cleanup(DRAFT, [...known.current])
    known.current.clear()
    setHero({ ...DEFAULT_HERO, headline: '', body: '' })
    reload()
    return 'Restored the default hero.'
  })

  const preview: AuthHero | null = hero.path || hero.headline || hero.body ? hero : null
  const shownHead = hero.headline || ''
  const shownBody = hero.body || ''

  return (
    <div className="hero-admin">
      <div className="notice" style={{ marginBottom: 16 }}>
        <b>Authentication hero.</b> Shown beside the sign-in and registration forms and on the landing page.
        {' '}Status: <b>{published ? 'Published' : 'Using the VYBE default'}</b>{dirty ? ' · unsaved changes' : isLive ? ' · draft matches what is live' : ''}.
      </div>

      <div className="hero-admin-grid">
        <div>
          <Field id="hero-file" label="Image or video" hint="JPG, PNG or WebP up to 10 MB; MP4 or WebM up to 50 MB. Large photos are resized automatically. Video plays muted on larger screens only.">
            <input id="hero-file" className="input" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" disabled={Boolean(busy)}
              onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} />
          </Field>
          {hero.path && (
            <div className="row" style={{ marginBottom: 16 }}>
              <span className="t-meta grow">{hero.media_type === 'video' ? 'Video' : 'Image'} attached{hero.media_type === 'video' && !hero.poster_path ? ' (no poster frame could be captured)' : ''}</span>
              <button className="btn sm danger" disabled={Boolean(busy)} onClick={() => set({ media_type: undefined, path: undefined, poster_path: undefined })}>Remove</button>
            </div>
          )}
          <Field id="hero-head" label="Headline (optional)" hint={`${hero.headline.length}/${HERO_LIMITS.headline}`}>
            <input id="hero-head" className="input" value={hero.headline} maxLength={HERO_LIMITS.headline} onChange={e => set({ headline: e.target.value })} />
          </Field>
          <Field id="hero-body" label="Supporting text (optional)" hint={`${hero.body.length}/${HERO_LIMITS.body}`}>
            <textarea id="hero-body" className="textarea" value={hero.body} maxLength={HERO_LIMITS.body} onChange={e => set({ body: e.target.value })} />
          </Field>
          {hero.path && <>
            <Field id="hero-ov" label={`Overlay strength: ${hero.overlay}%`} hint="Darkens the media so the text stays readable.">
              <input id="hero-ov" type="range" min={0} max={HERO_LIMITS.overlayMax} value={hero.overlay} onChange={e => set({ overlay: Number(e.target.value) })} />
            </Field>
            <Field id="hero-fx" label={`Focal point, horizontal: ${hero.focal_x}%`} hint="Which part of the picture stays in view when it is cropped.">
              <input id="hero-fx" type="range" min={0} max={100} value={hero.focal_x} onChange={e => set({ focal_x: Number(e.target.value) })} />
            </Field>
            <Field id="hero-fy" label={`Focal point, vertical: ${hero.focal_y}%`}>
              <input id="hero-fy" type="range" min={0} max={100} value={hero.focal_y} onChange={e => set({ focal_y: Number(e.target.value) })} />
            </Field>
          </>}
          {msg && <p className={`notice ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginBottom: 16 }}>{msg.text}</p>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn" disabled={Boolean(busy) || !dirty} onClick={saveDraft}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
            <button className="btn primary" disabled={Boolean(busy)} onClick={publish}>{busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
            {published && <button className="btn" disabled={Boolean(busy)} onClick={unpublish}>Unpublish</button>}
            <button className="btn ghost danger" disabled={Boolean(busy)} onClick={restore}>Restore default</button>
          </div>
          {busy === 'upload' && <p className="t-meta" role="status" style={{ marginTop: 8 }}>Uploading…</p>}
        </div>

        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 className="t-section grow">Preview {hero.path ? '(draft, not yet public)' : ''}</h2>
            <div role="group" aria-label="Preview size" className="chips">
              {(['desktop', 'mobile'] as const).map(d => <button key={d} className="chip" aria-pressed={device === d} onClick={() => setDevice(d)}>{d === 'desktop' ? 'Desktop' : 'Mobile'}</button>)}
            </div>
          </div>
          <div className={`hero-preview ${device}`}>
            <HeroMedia hero={preview} src={urls.src ?? ''} poster={urls.poster ?? ''} wide={device === 'desktop'}>
              <HeroContent headline={shownHead || (preview ? '' : DEFAULT_HERO.headline)} body={shownBody || (preview ? '' : DEFAULT_HERO.body)} />
            </HeroMedia>
          </div>
          <p className="t-meta" style={{ marginTop: 8 }}>With no media and no text, visitors see the VYBE default shown when nothing is published.</p>
        </div>
      </div>
    </div>
  )
}
