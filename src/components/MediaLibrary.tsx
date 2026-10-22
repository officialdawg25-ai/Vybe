import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Film, ImageIcon, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { useAsync } from '../lib/hooks'
import { addToLibrary, deleteAsset, listAssets, processAsset, type Asset } from '../lib/library'
import { fileSize, validateMedia } from '../lib/media'
import { Empty, ErrorState, Spinner, errMsg, toast, useSigned } from '../ui'

interface Pending { id: string; name: string; pct: number; error?: string; ctrl: AbortController }

const STATUS: Record<Asset['status'], string> = { uploaded: 'Waiting for a check', processing: 'Checking…', ready: 'Ready', failed: 'Problem' }

/**
 * A member's or an organisation's photos and videos. Uploads start on pick (several at once, with progress); each file then
 * gets a server check (media-process) whose result is shown on its tile. Organisation libraries are shared with the
 * organisation's members; deleting is for the uploader, or the organisation's owners and admins.
 */
export function MediaLibrary({ orgId, canManage = true }: { orgId?: string | null; canManage?: boolean }) {
  const { uid } = useAuth()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const list = useAsync(() => listAssets(orgId ?? null), [orgId])
  // While anything is being checked, look again every few seconds (stops as soon as nothing is in progress).
  const busy = (list.data ?? []).some(a => a.status === 'uploaded' || a.status === 'processing')
  useEffect(() => { if (!busy) return; const t = setInterval(list.reload, 4000); return () => clearInterval(t) }, [busy]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => pending.forEach(p => p.ctrl.abort()), []) // eslint-disable-line react-hooks/exhaustive-deps

  const add = (files: FileList | null) => {
    if (!files || !uid) return
    for (const f of Array.from(files)) {
      const c = validateMedia(f)
      if (!c.ok) { toast(`${f.name}: ${c.error}`); continue }
      const p: Pending = { id: crypto.randomUUID(), name: f.name, pct: 0, ctrl: new AbortController() }
      setPending(x => [...x, p])
      addToLibrary(uid, f, { organizationId: orgId ?? null, signal: p.ctrl.signal, onProgress: (s, t) => setPending(x => x.map(y => (y.id === p.id ? { ...y, pct: Math.round(s / t * 100) } : y))) })
        .then(id => { setPending(x => x.filter(y => y.id !== p.id)); if (id === null) toast('The media library needs the latest database update.'); list.reload() },
          e => { if (!p.ctrl.signal.aborted) setPending(x => x.map(y => (y.id === p.id ? { ...y, error: errMsg(e) } : y))) })
    }
  }
  const remove = async (a: Asset) => {
    if (!confirm(`Delete “${a.title || 'this file'}” from the library?`)) return
    try { const gone = await deleteAsset(a, uid!); toast(gone ? 'Deleted' : 'Removed from the library. The file stays because something on VYBE still shows it.'); list.reload() } catch (e) { toast(errMsg(e)) }
  }
  const recheck = async (a: Asset) => { const r = await processAsset(a.id); if (!r) toast('The check could not run. Try again shortly.'); list.reload() }

  if (list.loading && !list.data) return <Spinner />
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  if (list.data === null) return <p className="notice" role="status">The media library needs the latest database update.</p>
  return (
    <section aria-label="Media library" className="lib">
      <div className="row between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <p className="t-meta grow">{orgId ? 'Shared with everyone in this organisation.' : 'Only you can see your library.'} Photos up to 25 MB, videos up to 50 MB. Each file is checked on the server after it uploads.</p>
        <button className="btn primary sm" onClick={() => input.current?.click()}><Upload size={16} aria-hidden /> Upload</button>
        <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" className="sr-only" aria-label="Choose photos or videos for the library" onChange={e => { add(e.target.files); e.target.value = '' }} />
      </div>
      {pending.length > 0 && (
        <ul className="lib-pending" aria-label="Uploading">
          {pending.map(p => (
            <li key={p.id} className="row" style={{ gap: 8 }}>
              <span className="grow clamp-1">{p.name}</span>
              {p.error ? <><span className="error" role="alert">{p.error}</span><button className="btn sm" onClick={() => setPending(x => x.filter(y => y.id !== p.id))}>Dismiss</button></>
                : <><progress className="cp-prog" max={100} value={p.pct} aria-label={`Uploading ${p.name}`} /><button className="btn sm ghost" onClick={() => { p.ctrl.abort(); setPending(x => x.filter(y => y.id !== p.id)) }}>Cancel</button></>}
            </li>
          ))}
        </ul>
      )}
      {!list.data.length && !pending.length ? (
        <Empty title="Nothing here yet" action={<button className="btn primary" onClick={() => input.current?.click()}>Upload photos or videos</button>}>{orgId ? 'Keep posters, logos, venue shots and clips in one place for the whole team.' : 'Keep photos and videos ready to use in posts.'}</Empty>
      ) : (
        <ul className="lib-grid">{list.data.map(a => <Tile key={a.id} a={a} mine={a.owner === uid} canManage={canManage} onDelete={() => void remove(a)} onRecheck={() => void recheck(a)} />)}</ul>
      )}
    </section>
  )
}

function Tile({ a, mine, canManage, onDelete, onRecheck }: { a: Asset; mine: boolean; canManage: boolean; onDelete: () => void; onRecheck: () => void }) {
  const thumb = useSigned(a.thumb_path)
  const Icon = a.kind === 'video' ? Film : ImageIcon
  const facts = [a.width && a.height ? `${a.width}×${a.height}` : null, a.duration_ms != null ? `${Math.round(a.duration_ms / 1000)} s` : null, fileSize(a.bytes)].filter(Boolean).join(' · ')
  return (
    <li className={`lib-tile s-${a.status}`}>
      <div className="lib-art" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>{!thumb && <Icon size={28} aria-hidden />}</div>
      <div className="lib-body">
        <span className="t-name clamp-1">{a.title || (a.kind === 'video' ? 'Video' : 'Photo')}</span>
        <span className="t-meta clamp-1">{facts}</span>
        <span className="lib-status" role={a.status === 'failed' ? 'alert' : undefined}>
          {a.status === 'ready' ? <CheckCircle2 size={14} aria-hidden /> : a.status === 'failed' ? <AlertTriangle size={14} aria-hidden /> : <Loader2 size={14} className="spin" aria-hidden />}
          {STATUS[a.status]}{a.error ? `: ${a.error}` : ''}
        </span>
        <div className="row" style={{ gap: 6 }}>
          {a.status !== 'ready' && <button className="btn sm ghost" onClick={onRecheck} aria-label={`Check ${a.title || 'file'} again`}><RefreshCw size={14} aria-hidden /> Check again</button>}
          {(mine || canManage) && <button className="icon-btn" onClick={onDelete} aria-label={`Delete ${a.title || 'file'}`}><Trash2 size={16} /></button>}
        </div>
      </div>
    </li>
  )
}
