import { useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/** A section that folds away so long lists (topics, filters) never crowd the screen. The header always shows a short summary. */
export function Collapse({ title, summary, defaultOpen = false, children, className = '' }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={`collapse${open ? ' open' : ''} ${className}`.trim()}>
      <button type="button" className="collapse-h" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        <span className="collapse-t">{title}</span>
        {summary != null && summary !== '' && <span className="collapse-s">{summary}</span>}
        <ChevronDown size={20} aria-hidden className="collapse-c" />
      </button>
      {open && <div id={id} className="collapse-b">{children}</div>}
    </div>
  )
}
