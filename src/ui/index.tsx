import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { cachedUrl, invalidateSigned, signedExpiresIn, signedUrl } from '../lib/media'
import { useTheme, type ThemePref } from '../lib/theme'
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

/**
 * Signed-URL image. Initials are only a placeholder: while the picture is signing, loading or being retried they stay
 * underneath, and the picture replaces them the moment it is ready. A failed load re-signs and retries rather than giving up.
 */
export function Avatar({ path, name, size }: { path?: string | null; name: string; size?: 'sm' | 'lg' }) {
  const { url, refresh } = useSignedState(path)
  const [ready, setReady] = useState(false)
  const fails = useRef(0)
  useEffect(() => { setReady(false) }, [url])
  useEffect(() => { fails.current = 0 }, [path])
  const cls = `avatar ${size ?? ''}`
  return (
    <span className={`${cls} avatar-wrap`} aria-hidden="true">
      <span className="avatar-initial">{(name || '?').trim().charAt(0).toUpperCase()}</span>
      {url && <img className={`avatar-img${ready ? ' ready' : ''}`} src={url} alt="" decoding="async" onLoad={() => { fails.current = 0; setReady(true) }}
        onError={() => { setReady(false); if (fails.current++ < 3) refresh() }} />}
    </span>
  )
}

const RETRY_MS = [1200, 3500, 9000, 25000]
/**
 * Signed URL for a stored file, kept alive: retries with backoff when signing fails, re-signs shortly before the URL expires,
 * and tries again when the tab regains focus or the network returns. `refresh()` forces a new signature (e.g. after a load error).
 */
export function useSignedState(path?: string | null) {
  const [url, setUrl] = useState<string | null>(() => cachedUrl(path))
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true, timer: number | undefined, attempt = 0
    const run = () => {
      const hit = cachedUrl(path)
      if (hit) { setUrl(hit); schedule(signedExpiresIn(path)); return }
      if (!path) { setUrl(null); return }
      signedUrl(path).then(u => {
        if (!live) return
        if (u) { setUrl(u); schedule(signedExpiresIn(path)) }
        else if (attempt < RETRY_MS.length) { timer = window.setTimeout(run, RETRY_MS[attempt++]) }
      })
    }
    const schedule = (ms: number | null) => { if (ms != null) { window.clearTimeout(timer); timer = window.setTimeout(() => { invalidateSigned(path); run() }, Math.max(ms, 5000)) } }
    const wake = () => { if (live && path && !cachedUrl(path)) { attempt = 0; run() } }
    run()
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake)
    return () => { live = false; window.clearTimeout(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake) }
  }, [path, nonce])
  return { url, refresh: () => { invalidateSigned(path); setNonce(n => n + 1) } }
}

export const useSigned = (path?: string | null) => useSignedState(path).url

/** Post media at its natural proportions (never cropped); a placeholder holds the space until the file has loaded. */
export function Media({ path, type, alt }: { path: string; type: 'image' | 'video'; alt?: string }) {
  const url = useSigned(path)
  const [ready, setReady] = useState(false)
  if (type === 'video') return url ? <video src={url} controls preload="metadata" playsInline aria-label={alt ?? 'Post video'} /> : <div className="skeleton" style={{ height: 240 }} />
  return (
    <div className={`media-frame${ready ? ' ready' : ''}`}>
      {!ready && <div className="skeleton media-skel" aria-hidden />}
      {url && <img src={url} alt={alt ?? 'Post image'} decoding="async" loading="lazy" onLoad={() => setReady(true)} onError={() => setReady(true)} />}
    </div>
  )
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


const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon }

/** Cycles System → Light → Dark. `menu` renders it as a menu row, otherwise as an icon button. */
export function ThemeButton({ menu = false, className = 'icon-btn' }: { menu?: boolean; className?: string }) {
  const [pref, set] = useTheme()
  const Icon = THEME_ICON[pref]
  const label = `Theme: ${THEME_LABEL[pref]}. Switch to ${THEME_LABEL[NEXT[pref]]}`
  if (menu) return <button role="menuitem" className="pop-item" onClick={e => { e.stopPropagation(); set(NEXT[pref]) }} aria-label={label}><Icon size={20} aria-hidden /> Theme: {THEME_LABEL[pref]}</button>
  return <button className={className} onClick={() => set(NEXT[pref])} aria-label={label} title={label}><Icon size={20} aria-hidden /></button>
}

/** Explicit three-way choice for Settings. */
export function ThemeChoice() {
  const [pref, set] = useTheme()
  return (
    <div className="chips" role="radiogroup" aria-label="Theme">
      {(['system', 'light', 'dark'] as ThemePref[]).map(p => {
        const Icon = THEME_ICON[p]
        return <button key={p} role="radio" aria-checked={pref === p} className={`chip${pref === p ? ' on' : ''}`} onClick={() => set(p)}><Icon size={14} aria-hidden style={{ verticalAlign: '-2px', marginRight: 6 }} />{THEME_LABEL[p]}</button>
      })}
    </div>
  )
}
