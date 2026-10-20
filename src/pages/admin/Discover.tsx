import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { resetCategories, type Category } from '../../lib/discover'
import { mapsConfigured, resetMapsStatus } from '../../lib/maps'
import { ErrorState, Field, Spinner, errMsg } from '../../ui'

/** Admin → Discover: the category list that drives Concerts/Events filters and event forms, plus a health check for the maps integration. */
export default function AdminDiscover() {
  const cats = useAsync(async () => {
    const { data, error } = await supabase.from('event_categories').select('slug,label,group_key,sort,active').order('sort')
    if (error) throw error
    return (data ?? []) as Category[]
  }, [])
  const maps = useAsync(async () => { resetMapsStatus(); return mapsConfigured() }, [])
  const [draft, setDraft] = useState({ slug: '', label: '', group_key: 'events' as Category['group_key'] })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setMsg(null)
    const { error } = await fn()
    if (error) return setMsg({ kind: 'err', text: errMsg(error) })
    resetCategories(); setMsg({ kind: 'ok', text: ok }); cats.reload()
  }
  if (cats.loading && !cats.data) return <Spinner />
  if (cats.error) return <ErrorState message={cats.error} onRetry={cats.reload} />
  return (
    <div className="stack">
      <div className="notice"><b>Maps.</b> {maps.loading ? 'Checking…' : maps.data
        ? 'The maps function answers and reports a Google key. Place search, static maps and travel times are switched on.'
        : 'Maps are not configured. Discover, event pages and event creation work without them (addresses and “open in Google Maps” links still show). Set GOOGLE_MAPS_SERVER_KEY in Edge Function secrets and deploy the `maps` function.'}
        {' '}<button className="linklike" onClick={maps.reload}>Re-check</button></div>
      <section className="card">
        <h2 className="t-section">Event categories</h2>
        <p className="t-meta" style={{ marginBottom: 8 }}>“Concerts &amp; shows” categories appear under the Concerts destination; every active category appears under Events and in the event form. Deactivate instead of deleting so past events keep their label.</p>
        <div className="list">
          {(cats.data ?? []).map(c => (
            <div key={c.slug} className="item row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="grow"><div className="t-name">{c.label}</div><div className="t-meta">{c.slug} · {c.group_key === 'concerts' ? 'Concerts & shows' : 'Events'} · {c.active ? 'active' : 'hidden'}</div></div>
              <button className="btn sm" onClick={() => run(() => supabase.from('event_categories').update({ active: !c.active }).eq('slug', c.slug), c.active ? 'Hidden from filters.' : 'Visible again.')}>{c.active ? 'Hide' : 'Show'}</button>
              <button className="btn sm" onClick={() => run(() => supabase.from('event_categories').update({ group_key: c.group_key === 'concerts' ? 'events' : 'concerts' }).eq('slug', c.slug), 'Moved.')}>{c.group_key === 'concerts' ? 'Move to Events' : 'Move to Concerts'}</button>
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <h2 className="t-section">Add a category</h2>
        <Field id="cat-label" label="Name"><input id="cat-label" className="input" maxLength={40} value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value, slug: draft.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) })} /></Field>
        <Field id="cat-slug" label="Identifier" hint="Lowercase letters, numbers and dashes. Cannot be changed later."><input id="cat-slug" className="input" maxLength={30} value={draft.slug} onChange={e => setDraft({ ...draft, slug: e.target.value.toLowerCase() })} /></Field>
        <Field id="cat-group" label="Show under"><select id="cat-group" className="select" value={draft.group_key} onChange={e => setDraft({ ...draft, group_key: e.target.value as Category['group_key'] })}><option value="events">Events</option><option value="concerts">Concerts &amp; shows</option></select></Field>
        <button className="btn primary" disabled={!/^[a-z0-9-]{2,30}$/.test(draft.slug) || draft.label.trim().length < 2}
          onClick={() => run(() => supabase.from('event_categories').insert({ slug: draft.slug, label: draft.label.trim(), group_key: draft.group_key, sort: 200 }), 'Category added.').then(() => setDraft({ slug: '', label: '', group_key: 'events' }))}>Add category</button>
        {msg && <p className={msg.kind === 'err' ? 'error' : 't-meta'} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginTop: 8 }}>{msg.text}</p>}
      </section>
    </div>
  )
}
