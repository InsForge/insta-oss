import { useParams } from 'react-router-dom'
import { api } from '../api'
import { usePoll } from '../hooks'

/** Logs land with the docker-backed observability endpoints (roadmap Phase 2). Until the daemon
 *  serves them this page states that honestly instead of faking data. */
export function Logs() {
  const { projectId, branch } = useParams() as { projectId: string; branch: string }
  const { data, error } = usePoll(() => api.logs(projectId, 'compute'), [projectId], 60000)

  if (!data) {
    return (
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="mb-8 text-3xl font-bold text-neutral-900">Logs</h1>
        <div className="rounded-xl border border-dashed border-neutral-200 px-6 py-10 text-center">
          <p className="text-sm font-medium text-neutral-600">Coming with the docker-backed observability phase</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-400">
            {error && 'status' in error && (error as { status?: number }).status === 501
              ? 'The daemon will tail this branch\'s containers via docker logs — same response shape as the cloud.'
              : error?.message}
          </p>
          <p className="mt-4 font-mono text-xs text-neutral-400">
            meanwhile: docker logs io-&lt;project&gt;-{branch}-app-&lt;group&gt;
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-8 text-3xl font-bold text-neutral-900">Logs</h1>
      <pre className="overflow-x-auto rounded-xl bg-neutral-900 p-4 text-xs text-neutral-100">{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}
