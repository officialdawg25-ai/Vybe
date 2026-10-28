import { useState, type ReactNode } from 'react'
import { Sheet } from '../ui'

/**
 * A dedicated confirmation screen for things that are hard to undo or affect another person (blocking, unfriending):
 * says plainly what will and will not happen, with a clear red action and a Cancel that is always one tap away.
 */
export function ConfirmSheet({ title, icon, lead, points, confirmLabel, onConfirm, onClose }: {
  title: string; icon?: ReactNode; lead?: string; points: string[]; confirmLabel: string; onConfirm: () => void | Promise<void>; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const go = async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false); onClose() } }
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="confirm">
        {icon && <span className="confirm-ico" aria-hidden>{icon}</span>}
        {lead && <p className="confirm-lead">{lead}</p>}
        <ul className="confirm-points">{points.map(p => <li key={p}>{p}</li>)}</ul>
        <button className="btn danger confirm-go" disabled={busy} onClick={() => void go()}>{confirmLabel}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Sheet>
  )
}
