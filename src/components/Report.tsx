import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Field, Sheet, errMsg, toast } from '../ui'
import { useSubmit } from '../lib/hooks'
import { useAuth } from '../auth/AuthProvider'

export type ReportTarget = { type: 'profile' | 'post' | 'comment' | 'message' | 'community' | 'event' | 'stream'; id: string }

export function ReportSheet({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const { uid } = useAuth()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, submit] = useSubmit()
  const send = () => submit(async () => {
    const { error } = await supabase.from('reports').insert({ reporter: uid, entity_type: target.type, entity_id: target.id, reason: reason.trim() })
    if (error) return setErr(error.code === '23505' ? 'You have already reported this.' : errMsg(error))
    toast('Report submitted. Thank you.')
    onClose()
  })
  return (
    <Sheet title={`Report ${target.type}`} onClose={onClose}>
      <Field id="reason" label="What's wrong?" hint="Our team reviews every report. The person won't be told who reported them.">
        <textarea id="reason" className="textarea" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} />
      </Field>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || reason.trim().length < 3} onClick={send}>Submit report</button>
      </div>
    </Sheet>
  )
}
