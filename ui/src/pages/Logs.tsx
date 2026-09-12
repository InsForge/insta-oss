import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { EmptyState, Tab, Tabs, cn } from '@insforge/ui'
import { Moon, ScrollText } from 'lucide-react'
import { api, type LogLine, type ObsComponent } from '../api'
import { usePoll } from '../hooks'
import { healthFor } from '../lib/status'
import { ConsolePage } from '../components/console/ConsolePage'

type Component = ObsComponent

/** "io-demo-main-app-worker" → "worker"; the pg container → "postgres". */
export function instanceLabel(instance?: string): string {
  if (!instance) return ''
  if (instance.endsWith('-pg')) return 'postgres'
  const m = /-app-(.+)$/.exec(instance)
  return m ? m[1] : instance
}

/** Whether a container label belongs to the service named `name`: an app's label is its group, a
 *  managed or extra postgres container ends in `-<name>`, and the default database is "postgres". */
export function labelMatches(label: string, name: string): boolean {
  return label === name || label.endsWith(`-${name}`) || (name === 'db' && label === 'postgres')
}

function LogRows({ lines }: { lines: LogLine[] }) {
  const bottom = useRef<HTMLDivElement>(null)
  const count = useRef(0)
  useEffect(() => {
    if (lines.length !== count.current) {
      count.current = lines.length
      bottom.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [lines])
  const instances = new Set(lines.map((l) => l.instance))
  return (
    <div className="max-h-[32rem] overflow-auto font-mono text-[13px] leading-6">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-3 px-4 whitespace-pre-wrap hover:bg-alpha-4">
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {l.ts ? l.ts.slice(0, 19).replace('T', ' ') : '—'}
          </span>
          {instances.size > 1 && (
            <span className="shrink-0 text-info">{instanceLabel(l.instance)}</span>
          )}
          <span className="min-w-0 break-all">{l.message}</span>
        </div>
      ))}
      <div ref={bottom} />
    </div>
  )
}

/** The live container tail, for the Logs page and a service's Runtime Logs tab. `service` narrows
 *  it to one service's container. Reading logs never wakes anything. */
export function LogsPanel({ projectId, branch, component, service }: {
  projectId: string; branch: string; component: Component; service?: { name: string }
}) {
  const { data, error } = usePoll(() => api.logs(projectId, component, branch), [projectId, branch, component])
  const { data: services } = usePoll(() => api.services(projectId, branch), [projectId, branch], 15000)
  const { data: health } = usePoll(() => api.runtimeHealth(projectId, branch), [projectId, branch], 15000)

  const wanted = (services ?? []).filter((s) => service
    ? s.name === service.name
    : component === 'compute' ? s.type === 'compute' : s.type === 'postgres')
  const standby = wanted.length > 0 && wanted.every((s) => healthFor(health, s.id)?.status === 'standby')
  const lines = data ? (service ? data.lines.filter((l) => labelMatches(instanceLabel(l.instance), service.name)) : data.lines) : undefined

  return (
    <div className="flex flex-col gap-3">
      {standby && (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Moon className="size-3.5" /> Sleeping; showing the last lines before it went to sleep.
        </p>
      )}
      {!data && !error && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn('h-4 animate-pulse rounded-md bg-alpha-8', i % 2 ? 'w-3/4' : 'w-full')} />
          ))}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-destructive">{error.message}</div>
      )}
      {lines && lines.length === 0 && (
        <div className="rounded-lg border border-border bg-card py-12">
          <EmptyState icon={ScrollText} title="No logs yet."
            description={component === 'compute'
              ? 'Deploy an app to this environment and its container output lands here.'
              : 'The database has not written any log lines yet.'} />
        </div>
      )}
      {lines && lines.length > 0 && (
        <div className="rounded-lg border border-border bg-card py-2">
          <LogRows lines={lines} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Tailed live from this environment&apos;s containers ({data?.source ?? 'docker-logs'}); refreshes every 5s.
      </p>
    </div>
  )
}

export function Logs() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const [component, setComponent] = useState<Component>('compute')
  return (
    <ConsolePage title="Logs"
      action={
        <Tabs value={component} onValueChange={setComponent}>
          <Tab value="compute">App</Tab>
          <Tab value="db">Database</Tab>
        </Tabs>
      }>
      <LogsPanel projectId={projectId} branch={branch} component={component} />
    </ConsolePage>
  )
}
