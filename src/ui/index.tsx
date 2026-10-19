import { useEffect, useState, type ReactNode } from 'react'
import { signedUrl } from '../lib/media'
import { t } from '../lib/i18n'

export function Spinner() {
  return <div className="spinner" role="status" aria-label={t('common.loading')} />
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <h2>{t('error.generic')}</h2>
      <p>{message}</p>
      {onRetry && <button className="btn" onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  )
}

/** Signed-URL image; falls back to initials. */
export function Avatar({ path, name, size }: { path?: string | null; name: string; size?: 'sm' | 'lg' }) {
  const url = useSigned(path)
  const cls = `avatar ${size ?? ''}`
  if (url) return <img className={cls} src={url} alt="" loading="lazy" />
  return <span className={cls} aria-hidden="true">{(name || '?').trim().charAt(0).toUpperCase()}</span>
}

export function useSigned(path?: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setUrl(null)
    if (path) signedUrl(path).then(u => live && setUrl(u))
    return () => { live = false }
  }, [path])
  return url
}

export function Media({ path, type, alt }: { path: string; type: 'image' | 'video'; alt?: string }) {
  const url = useSigned(path)
  if (!url) return <div className="skeleton" style={{ height: 240 }} />
  return type === 'image'
    ? <img src={url} alt={alt ?? 'Post image'} loading="lazy" />
    : <video src={url} controls preload="metadata" playsInline aria-label={alt ?? 'Post video'} />
}

/** Bottom sheet on mobile, centred dialog on desktop. Escape and backdrop close it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="sheet-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="t-title" style={{ marginBottom: 16 }}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

let toastSet: ((m: string) => void) | null = null
export const toast = (m: string) => toastSet?.(m)
export function Toaster() {
  const [msg, setMsg] = useState('')
  useEffect(() => {
    toastSet = m => { setMsg(m); setTimeout(() => setMsg(''), 3200) }
    return () => { toastSet = null }
  }, [])
  return msg ? <div className="toast" role="status">{msg}</div> : null
}

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(i => (
        <button key={i.id} role="tab" aria-selected={value === i.id} className="tab" onClick={() => onChange(i.id)}>{i.label}</button>
      ))}
    </div>
  )
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : 'Unknown error')
