// Reducing the daemon's metric series to "the latest value per container".
//
// Keyed by the RAW container name, never by its display label. `instanceLabel` is not injective —
// the branch's default database (`io-<ref>-pg`) and a postgres service named `pg`
// (`io-<ref>-pg-pg`) both reduce to "postgres" — so keying here silently overwrote one service
// with the other, and it disappeared from the cards and from every chart. Labels are applied at
// render, where a collision costs only a longer name.

import type { MetricSeries } from '../api'

/** Latest value per raw container instance for one metric name across the returned series. */
export function latestByInstance(series: readonly MetricSeries[], name: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of series) {
    if (s.name !== name) continue
    const instance = s.labels?.instance
    const last = s.points[s.points.length - 1]
    if (instance && last) out[instance] = last[1]
  }
  return out
}
