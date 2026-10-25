import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAsync } from '../../lib/hooks'
import { isMissingSchema } from '../../lib/tickets'
import { ErrorState, Spinner, Tabs } from '../../ui'

interface Row { name: string; route: string; mode: string; n: number; p50: number; p75: number; p95: number }
type Days = '1' | '7' | '30'

const LABELS: Record<string, { label: string; unit: 'ms' | 'score' | 'count' }> = {
  first_post: { label: 'First post on screen', unit: 'ms' },
  lcp: { label: 'Largest content painted (LCP)', unit: 'ms' },
  fcp: { label: 'First content painted (FCP)', unit: 'ms' },
  inp: { label: 'Slowest tap response (INP)', unit: 'ms' },
  cls: { label: 'Layout shift (CLS)', unit: 'score' },
  ttfb: { label: 'Server first byte (TTFB)', unit: 'ms' },
  reel_start: { label: 'Reel start-up', unit: 'ms' },
  reel_stall_ms: { label: 'Reel stall length', unit: 'ms' },
  live_first_frame: { label: 'Live: first video frame', unit: 'ms' },
  live_reconnect: { label: 'Live: reconnections', unit: 'count' },
}
const fmt = (v: number, unit: string) => unit === 'score' ? v.toFixed(3) : unit === 'count' ? String(Math.round(v)) : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`

/**
 * Admin → Performance: what real devices measure, as percentiles (p75 is the usual target). Numbers come from one session
 * in four, anonymously (lib/metrics.ts, migration 25); rows with few samples are shown but marked, never extrapolated.
 */
export default function AdminPerformance() {
  const [days, setDays] = useState<Days>('7')
  const rows = useAsync(async () => {
    const { data, error } = await supabase.rpc('client_metrics_summary', { days: Number(days) })
    if (error) { if (isMissingSchema(error)) return null; throw error }
    return (data ?? []) as Row[]
  }, [days])
  const groups = new Map<string, Row[]>()
  for (const r of rows.data ?? []) groups.set(r.name, [...(groups.get(r.name) ?? []), r])
  const order = Object.keys(LABELS).filter(k => groups.has(k))
  return (
    <div className="stack">
      <Tabs value={days} onChange={setDays} items={[{ id: '1', label: '24 hours' }, { id: '7', label: '7 days' }, { id: '30', label: '30 days' }]} />
      {rows.loading && !rows.data ? <Spinner />
        : rows.error ? <ErrorState message={rows.error} onRetry={rows.reload} />
        : rows.data === null ? <p className="notice" role="status">Performance numbers need database update 25.</p>
        : !order.length ? <p className="notice" role="status">No samples yet for this period. One visit in four from signed-in members reports its numbers, so they appear as people use the app.</p>
        : order.map(name => {
            const { label, unit } = LABELS[name]
            return (
              <section key={name} className="card">
                <h2 className="t-section">{label}</h2>
                <table className="fin-table">
                  <thead><tr><th scope="col">Screen · data mode</th><th scope="col">Samples</th><th scope="col">p50</th><th scope="col">p75</th><th scope="col">p95</th></tr></thead>
                  <tbody>{groups.get(name)!.map(r => (
                    <tr key={`${r.route}-${r.mode}`}>
                      <th scope="row">{r.route} · {r.mode}{r.n < 20 && <span className="t-meta"> (few samples)</span>}</th>
                      <td>{r.n}</td><td>{fmt(r.p50, unit)}</td><td>{fmt(r.p75, unit)}</td><td>{fmt(r.p95, unit)}</td>
                    </tr>))}</tbody>
                </table>
              </section>
            )
          })}
    </div>
  )
}
