import { Check, RotateCw, X } from 'lucide-react'
import { discardPublish, dismissPublish, retryPublish, usePublishing, type PublishJob } from '../lib/publisher'

const WHAT: Record<PublishJob['kind'], string> = { post: 'post', memory: 'memory', reel: 'reel' }
/** Technical server messages are not shown as they are; the member gets a plain next step instead. */
const why = (e?: string) => (!e ? '' : /violates|policy|permission|jwt|json|pgrst|fetch|network|load failed|timeout|42\d{3}/i.test(e) ? 'Check your connection, then tap Retry.' : e)

/**
 * The slim strip under the header while something publishes: a thumbnail, "Sharing your post…" and a hairline progress
 * bar; then "Shared" with a tick for a moment; or, if it failed, Retry and Discard. Announced politely to screen readers.
 */
export function PublishBar() {
  const jobs = usePublishing()
  if (!jobs.length) return null
  return (
    <div className="pub" aria-live="polite">
      {jobs.map(j => (
        <div key={j.id} className={`pub-row ${j.status}`} role="status">
          {j.thumb ? <img className="pub-thumb" src={j.thumb} alt="" /> : <span className="pub-thumb pub-thumb-empty" aria-hidden />}
          <span className="pub-text">
            {j.status === 'running' ? <>Sharing your {WHAT[j.kind]}…</>
              : j.status === 'done' ? <><Check size={16} aria-hidden className="pub-tick" /> Your {WHAT[j.kind]} is shared</>
              : <span className="pub-err">Couldn’t share your {WHAT[j.kind]}{why(j.error) ? <span className="pub-why clamp-1">{why(j.error)}</span> : null}</span>}
          </span>
          {j.status === 'failed' && <>
            <button className="pub-btn" onClick={() => retryPublish(j.id)}><RotateCw size={15} aria-hidden /> Retry</button>
            <button className="pub-x" aria-label="Discard" onClick={() => discardPublish(j.id)}><X size={18} /></button>
          </>}
          {j.status === 'done' && <button className="pub-x" aria-label="Close" onClick={() => dismissPublish(j.id)}><X size={18} /></button>}
          {j.status === 'running' && (
            <span className={`pub-bar${j.progress == null ? ' busy' : ''}`} role="progressbar" aria-label={`Sharing your ${WHAT[j.kind]}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.progress == null ? undefined : Math.round(j.progress * 100)}>
              <i style={j.progress == null ? undefined : { width: `${Math.max(4, j.progress * 100)}%` }} />
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
