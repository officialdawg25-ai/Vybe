import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'

export interface WizardCtx { go: (id: string) => void }
export interface WizardStep {
  id: string
  /** Short phase name shown in the progress bar ("The idea", "When", "Review"…). Steps that share a phase share a segment. */
  phase: string
  title: string
  hint?: string
  /** Hidden steps are skipped (e.g. "Where" for an online-only plan). */
  hidden?: boolean
  /** Optional steps show a Skip button while empty. */
  optional?: boolean
  /** Returns a message when the step cannot be left yet. */
  check?: () => string | null
  body: ReactNode | ((ctx: WizardCtx) => ReactNode)
}
export interface WizardAction { label: string; onClick: () => void; primary?: boolean; busy?: boolean }

/**
 * Step-by-step flow for creating things (plans, events, communities): one decision per screen, grouped into named phases,
 * with a progress bar, a review step and the final actions. It replaces long forms.
 */
export function Wizard({ steps, title, onClose, actions, error, dirty = false, startAt }: { steps: WizardStep[]; title: string; onClose: () => void; actions: WizardAction[]; error?: string; dirty?: boolean; startAt?: string }) {
  const visible = steps.filter(s => !s.hidden)
  const [at, setAt] = useState(() => Math.max(0, visible.findIndex(s => s.id === startAt)))
  const [msg, setMsg] = useState('')
  const head = useRef<HTMLHeadingElement>(null)
  const idx = Math.min(at, visible.length - 1), step = visible[idx], last = idx === visible.length - 1
  const phases = [...new Set(visible.map(s => s.phase))], phaseNo = phases.indexOf(step.phase)

  useEffect(() => { head.current?.focus({ preventScroll: true }); window.scrollTo?.({ top: 0 }) }, [step.id])
  useEffect(() => { document.documentElement.classList.add('wizard-open'); return () => document.documentElement.classList.remove('wizard-open') }, [])
  const close = () => { if (!dirty || confirm('Leave without finishing? What you entered will be lost.')) onClose() }
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  })
  const next = () => { const m = step.check?.() ?? null; if (m) return setMsg(m); setMsg(''); setAt(idx + 1) }
  const back = () => { setMsg(''); idx === 0 ? close() : setAt(idx - 1) }
  const go = (id: string) => { const i = visible.findIndex(s => s.id === id); if (i >= 0) { setMsg(''); setAt(i) } }
  const body = typeof step.body === 'function' ? step.body({ go }) : step.body

  return (
    <div className="wz" role="region" aria-label={title}>
      <header className="wz-top">
        <button className="icon-btn" type="button" aria-label={idx === 0 ? `Close ${title}` : 'Go back'} onClick={back}>{idx === 0 ? <X size={24} /> : <ArrowLeft size={24} />}</button>
        <div className="wz-prog" role="progressbar" aria-label={`${title}: step ${idx + 1} of ${visible.length}`} aria-valuemin={1} aria-valuemax={visible.length} aria-valuenow={idx + 1}>
          {phases.map((p, i) => {
            const mine = visible.filter(s => s.phase === p), done = mine.filter(s => visible.indexOf(s) <= idx).length
            return <span key={p} className={`wz-seg${i < phaseNo ? ' done' : i === phaseNo ? ' now' : ''}`}><i style={{ width: `${i < phaseNo ? 100 : i === phaseNo ? (done / mine.length) * 100 : 0}%` }} /></span>
          })}
        </div>
        {idx > 0 && <button className="icon-btn" type="button" aria-label={`Close ${title}`} onClick={close}><X size={22} /></button>}
      </header>
      <div className="wz-scroll">
        <form className="wz-card" onSubmit={e => { e.preventDefault(); if (!last) next() }} noValidate>
          <p className="wz-phase">{step.phase} · {idx + 1}/{visible.length}</p>
          <h1 className="wz-title" ref={head} tabIndex={-1}>{step.title}</h1>
          {step.hint && <p className="wz-hint">{step.hint}</p>}
          <div className="wz-body">{body}</div>
          {(msg || (last && error)) && <p className="error" role="alert">{msg || error}</p>}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </div>
      <footer className="wz-foot">
        {last
          ? <div className="wz-actions">{actions.map(a => <button key={a.label} type="button" className={`btn${a.primary ? ' primary' : ''}`} disabled={a.busy} onClick={a.onClick}>{a.busy ? 'Please wait…' : a.label}</button>)}</div>
          : <div className="wz-actions">
              {step.optional && <button type="button" className="btn ghost" onClick={() => { setMsg(''); setAt(idx + 1) }}>Skip</button>}
              <button type="button" className="btn primary" onClick={next}>Continue</button>
            </div>}
      </footer>
    </div>
  )
}

/** Big tappable choices for a single-answer step (format, privacy, who can see it). */
export function Choice<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; title: string; text?: string; icon?: ReactNode }[]; label: string }) {
  return (
    <div className="wz-choices" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`wz-choice${value === o.value ? ' on' : ''}`} onClick={() => onChange(o.value)}>
          {o.icon && <span className="wz-choice-ico" aria-hidden>{o.icon}</span>}
          <span><b>{o.title}</b>{o.text && <small>{o.text}</small>}</span>
        </button>
      ))}
    </div>
  )
}
