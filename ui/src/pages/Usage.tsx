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
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="mb-8 text-3xl font-bold text-neutral-900">Usage</h1>
        <div className="rounded-xl border border-dashed border-neutral-200 px-6 py-10 text-center">
          <p className="text-sm font-medium text-neutral-600">Local telemetry, not billing</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
            {error && 'status' in error && (error as { status?: number }).status === 501
              ? 'This page will show live CPU and memory per container via docker stats (roadmap Phase 2). insta-oss deliberately has no billing usage — that pipeline is cloud-only.'
              : error?.message}
          </p>
          <p className="mt-4 font-mono text-xs text-neutral-400">meanwhile: docker stats</p>
        </div>
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-8 text-3xl font-bold text-neutral-900">Usage</h1>
      <pre className="overflow-x-auto rounded-xl bg-neutral-900 p-4 text-xs text-neutral-100">{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}
