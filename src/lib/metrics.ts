/**
 * Performance samples gathered on this device: reel start-up time and stalls, live time-to-first-frame, feed timings.
 * Bounded (the last 200 of each kind), numbers only (no ids, URLs, names or content) and kept in memory. Lab checks read
 * them from window.__vybeMetrics; summarize() gives p50/p75/p95 for the report. Nothing is sent to a server yet: a
 * field-data sink needs an agreed destination and retention policy first (see docs/production-evolution-report.md).
 */
export type MetricName = 'reel_startup_ms' | 'reel_stall' | 'reel_stall_ms' | 'live_first_frame_ms' | 'live_reconnect' | 'feed_first_page_ms' | 'feed_next_page_ms'
const MAX = 200
const store = new Map<MetricName, number[]>()

export function record(name: MetricName, value: number) {
  if (!Number.isFinite(value) || value < 0) return
  const list = store.get(name) ?? []
  list.push(Math.round(value))
  if (list.length > MAX) list.shift()
  store.set(name, list)
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
export function summarize(name: MetricName) {
  const v = store.get(name) ?? []
  return { n: v.length, p50: percentile(v, 50), p75: percentile(v, 75), p95: percentile(v, 95) }
}
export const resetMetrics = () => store.clear()

if (typeof window !== 'undefined') (window as unknown as { __vybeMetrics: unknown }).__vybeMetrics = { summarize, raw: (n: MetricName) => [...(store.get(n) ?? [])] }
