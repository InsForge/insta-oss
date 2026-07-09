import { useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'

/** Local Usage = live docker stats (CPU/mem), not billing — insta-oss has no billing pipeline.
 *  Until the daemon serves the metrics endpoint this page states that honestly. */
export function Usage() {
  const { projectId } = useParams() as { projectId: string }
  const { data, error } = usePoll(() => api.metrics(projectId, 'compute'), [projectId], 60000)

  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
        <h1 className="text-[32px] leading-12 font-bold">Usage</h1>
        <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <p className="text-sm font-medium">Local telemetry, not billing</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {error && 'status' in error && (error as { status?: number }).status === 501
              ? 'This page will show live CPU and memory per container via docker stats (roadmap Phase 2). insta-oss deliberately has no billing usage — that pipeline is cloud-only.'
              : error?.message}
          </p>
          <p className="mt-4 font-mono text-xs text-muted-foreground">meanwhile: docker stats</p>
        </div>
      </div>
    )
  }
  return (
    <div className="mx-auto flex w-full max-w-[64rem] flex-col gap-4">
      <h1 className="text-[32px] leading-12 font-bold">Usage</h1>
      <pre className="overflow-x-auto rounded-lg bg-semantic-6 p-4 text-xs text-inverse">{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}
