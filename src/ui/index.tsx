import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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


/**
 * Anchored menu (account menu etc.). Opens below its trigger, stays inside the viewport, closes on Escape
 * (focus returns to the trigger), outside click, focus leaving, or choosing an item; arrow keys move between items.
 * Items are links/buttons carrying role="menuitem".
 */
export function Popover({ label, trigger, children, className = '' }: { label: string; trigger: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false)
  const [shift, setShift] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = (refocus = false) => { setOpen(false); if (refocus) btn.current?.focus() }

  useLayoutEffect(() => {
    if (!open || !panel.current) return setShift(0)
    const r = panel.current.getBoundingClientRect()
    setShift(r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0)
  }, [open])
  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    e.preventDefault()
  }
  return (
    <div className={`pop ${className}`} ref={root} onBlur={e => { if (open && !root.current?.contains(e.relatedTarget as Node | null) && e.relatedTarget) setOpen(false) }}>
      <button ref={btn} className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(o => !o)}>{trigger}</button>
      {open && (
        <div id={id} ref={panel} className="pop-panel" role="menu" aria-label={label} style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          onKeyDown={onPanelKey} onClick={e => { if ((e.target as HTMLElement).closest('[role="menuitem"]')) close() }}>
          {children}
        </div>
      )}
    </div>
  )
}
