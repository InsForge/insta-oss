import { useMemo, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { EmptyState } from '@insforge/ui'
import { Gauge } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api, obsComponentFor, type MetricSeries, type ObsComponent } from '../api'
import { usePoll } from '../hooks'
import { labelMatches } from './Logs'
import { ConsolePage } from '../components/console/ConsolePage'

// The one sanctioned hex exception: the chart series palette (Figma observability design).
const SERIES_COLORS = ['#10b981', '#ec4899', '#3b82f6']

/** "io-demo-main-app-worker" → "worker"; "io-demo-main-pg" → "postgres". */
function instanceLabel(raw = ''): string {
  if (raw.endsWith('-pg')) return 'postgres'
  const m = /-app-(.+)$/.exec(raw)
  return m ? m[1] : raw
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`
  return `${n.toFixed(0)} B`
}

type Snapshot = { t: number; values: Record<string, number> } // instance -> value
type History = { cpu: Snapshot[]; memory: Snapshot[] }

/** Latest value per instance for one metric name across the returned series. */
function latest(series: MetricSeries[], name: string, only?: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of series) {
    if (s.name !== name) continue
    const label = instanceLabel(s.labels?.instance)
    if (only && !labelMatches(label, only)) continue
    const last = s.points[s.points.length - 1]
    if (label && last) out[label] = last[1]
  }
  return out
}

const HH_MM_SS = (t: number): string => new Date(t).toLocaleTimeString([], { hour12: false })

function SeriesChart({ title, snapshots, unit, format }: {
  title: string; snapshots: Snapshot[]; unit: string; format: (n: number) => string
}) {
  const instances = useMemo(
    () => [...new Set(snapshots.flatMap((s) => Object.keys(s.values)))].sort(),
    [snapshots],
  )
  const data = snapshots.map((s) => ({ t: s.t, ...s.values }))
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <div className="mt-3 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="rgb(var(--foreground) / 0.06)" />
            <XAxis dataKey="t" tickFormatter={HH_MM_SS} axisLine={false} tickLine={false}
              tick={{ fontSize: 12 }} minTickGap={48} />
            <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} width={56}
              tickFormatter={(v: number) => format(v)} />
            <Tooltip
              labelFormatter={(t) => HH_MM_SS(Number(t))}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                return (
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">
                    <p className="text-muted-foreground">{HH_MM_SS(Number(label))}</p>
                    {payload.map((p) => (
                      <p key={String(p.dataKey)} className="mt-1 flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: p.color }} />
                        {String(p.dataKey)}: <span className="font-medium tabular-nums">{format(Number(p.value))}</span>
                      </p>
                    ))}
                  </div>
                )
              }}
            />
            {instances.map((name, i) => (
              <Line key={name} dataKey={name} type="stepAfter" strokeWidth={2} dot={false}
                isAnimationActive={false} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {instances.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-3">
          {instances.map((name, i) => (
            <span key={name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Live container telemetry — NOT billing (that pipeline is cloud-only by design). The daemon
 *  serves a point-in-time docker-stats snapshot; the panel accumulates them into a rolling window
 *  while open. `service` narrows it to one service (a service's Metrics tab). */
export function LiveMetrics({ projectId, branch, service }: {
  projectId: string; branch: string; service?: { name: string; type: string }
}) {
  const history = useRef<History>({ cpu: [], memory: [] })
  const only = service?.name

  // Each managed database is its own observability component. Fetching only `compute` and `db`
  // meant a Redis/MySQL/Mongo service's Metrics tab charted Postgres, or nothing at all.
  const { data: svcList } = usePoll(() => api.services(projectId, branch), [projectId, branch], 15000)
  const components = useMemo<ObsComponent[]>(() => {
    if (service) { const c = obsComponentFor(service.type); return c ? [c] : [] }
    const set = new Set<ObsComponent>()
    for (const s of svcList ?? []) { const c = obsComponentFor(s.type); if (c) set.add(c) }
    return [...set]
  }, [service, svcList])
  const componentKey = components.join(',')

  const { data, error } = usePoll(async () => {
    const answers = await Promise.all(components.map((c) => api.metrics(projectId, c, branch)))
    const series = answers.flatMap((a) => a.series)
    const t = Date.now()
    for (const name of ['cpu', 'memory'] as const) {
      const values = latest(series, name, only)
      if (Object.keys(values).length) {
        history.current[name] = [...history.current[name], { t, values }].slice(-240)
      }
    }
    return { series, note: answers.find((a) => a.note)?.note }
  }, [projectId, branch, only, componentKey])

  const cpuNow = data ? latest(data.series, 'cpu', only) : {}
  const memNow = data ? latest(data.series, 'memory', only) : {}
  const instances = [...new Set([...Object.keys(cpuNow), ...Object.keys(memNow)])].sort()

  return (
    <div className="flex flex-col gap-4">
      {!data && !error && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-alpha-8" />)}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      )}
      {data && instances.length === 0 && (
        <div className="rounded-lg border border-border bg-card py-12">
          <EmptyState icon={Gauge} title="Nothing running."
            description={service
              ? 'Metrics appear while this service is running; a sleeping service has none.'
              : 'Deploy an app to this environment and its live CPU and memory land here.'} />
        </div>
      )}
      {instances.length > 0 && (
        <>
          {!service && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {instances.map((name) => (
                <div key={name} className="rounded-lg border border-border bg-card p-4">
                  <p className="text-xs tracking-wide text-muted-foreground uppercase">{name}</p>
                  <div className="mt-2 flex items-baseline gap-4">
                    <span className="text-[28px] font-bold tabular-nums">
                      {(cpuNow[name] ?? 0).toFixed(1)}<span className="text-sm font-medium text-muted-foreground"> % cpu</span>
                    </span>
                    <span className="text-sm font-medium text-muted-foreground tabular-nums">{fmtBytes(memNow[name] ?? 0)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <SeriesChart title="CPU" unit="%" snapshots={history.current.cpu} format={(v) => `${v.toFixed(1)}%`} />
          <SeriesChart title="Memory" unit="bytes" snapshots={history.current.memory} format={fmtBytes} />
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Live container telemetry via docker stats, sampled every 5s while this is open — not billing
        (usage metering is cloud-only).
      </p>
    </div>
  )
}

export function Usage() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  return (
    <ConsolePage title="Observability"
      subtitle={<>Live CPU and memory for <span className="font-medium">{branch}</span>&apos;s containers</>}>
      <LiveMetrics projectId={projectId} branch={branch} />
    </ConsolePage>
  )
}
